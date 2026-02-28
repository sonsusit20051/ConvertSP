#!/usr/bin/env python3
"""Production-ready job queue backend for Shopee Affiliate converter.

Key upgrades vs PoC:
- FastAPI + Uvicorn for concurrent request handling.
- Strict CORS from environment (no wildcard).
- SQLite WAL mode + busy timeout for high-frequency polling.
- In-memory rate-limit state auto-cleanup to prevent unbounded growth.
- Background cleanup task to purge jobs older than retention window.
"""

from __future__ import annotations

import asyncio
import os
import re
import secrets
import sqlite3
import threading
import time
import uuid
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Deque, Dict, Optional
from urllib.parse import parse_qsl, unquote, urlparse

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

# -----------------------------
# Environment / configuration
# -----------------------------

DB_PATH = os.environ.get("DB_PATH", "backend/jobs.db")
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8787"))
WORKER_KEY = os.environ.get("WORKER_KEY", "change-me-worker-key")

MAX_PENDING_JOBS = int(os.environ.get("MAX_PENDING_JOBS", "2000"))
MAX_URL_LENGTH = int(os.environ.get("MAX_URL_LENGTH", "2048"))

USER_RATE_LIMIT_WINDOW_SEC = int(os.environ.get("USER_RATE_LIMIT_WINDOW_SEC", "10"))
USER_RATE_LIMIT_MAX = int(os.environ.get("USER_RATE_LIMIT_MAX", "6"))
RATE_LIMIT_CLEANUP_INTERVAL_SEC = int(os.environ.get("RATE_LIMIT_CLEANUP_INTERVAL_SEC", "60"))

JOB_RETENTION_HOURS = int(os.environ.get("JOB_RETENTION_HOURS", "24"))
JOB_CLEANUP_INTERVAL_SEC = int(os.environ.get("JOB_CLEANUP_INTERVAL_SEC", "300"))

# Comma-separated list: "https://app.example.com,https://admin.example.com"
ALLOWED_ORIGINS_RAW = os.environ.get(
    "ALLOWED_ORIGINS",
    "http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173",
)
# Optional regex for dev convenience (localhost on any port).
# Set empty string in production if you only want strict ALLOWED_ORIGINS.
ALLOWED_ORIGIN_REGEX = os.environ.get(
    "ALLOWED_ORIGIN_REGEX",
    r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
)

URL_REGEX = r"https?://[^\s\"'<>]+"
MAX_REDIRECT_DEPTH = 2


# -----------------------------
# Utilities
# -----------------------------


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def parse_allowed_origins(raw: str) -> list[str]:
    origins = [item.strip() for item in raw.split(",") if item.strip()]
    # Hard block wildcard in production path.
    if "*" in origins:
        raise RuntimeError("ALLOWED_ORIGINS không được chứa '*'.")
    return origins


def extract_urls(text: str) -> list[str]:
    return re.findall(URL_REGEX, text or "", flags=re.IGNORECASE)


def _normalize_host(host: str) -> str:
    return (host or "").strip().lower().rstrip(".")


def _is_shopee_market_host(host: str) -> bool:
    return bool(re.search(r"(^|\.)shopee\.[a-z.]+$", host, flags=re.IGNORECASE))


def _is_short_shopee_host(host: str) -> bool:
    if host in {"shope.ee", "shp.ee"}:
        return True
    if re.match(r"^[a-z0-9-]+\.shp\.ee$", host, flags=re.IGNORECASE):
        return True
    if re.match(r"^s\.shopee\.[a-z.]+$", host, flags=re.IGNORECASE):
        return True
    return False


def _is_affiliate_redirect_path(path: str) -> bool:
    normalized = (path or "/").rstrip("/").lower()
    return normalized == "/an_redir"


def _is_direct_product_path(path: str) -> bool:
    value = path or "/"
    return bool(
        re.search(r"-i\.(\d+)\.(\d+)/?$", value, flags=re.IGNORECASE)
        or re.match(r"^/product/(\d+)/(\d+)/?$", value, flags=re.IGNORECASE)
        or re.match(r"^/universal-link/product/(\d+)/(\d+)/?$", value, flags=re.IGNORECASE)
    )


def _parse_possibly_encoded_http_url(raw: str) -> Optional[str]:
    candidate = (raw or "").strip()
    if not candidate:
        return None

    for _ in range(MAX_REDIRECT_DEPTH + 1):
        parsed = urlparse(candidate)
        if parsed.scheme in {"http", "https"} and parsed.netloc:
            return candidate

        try:
            decoded = unquote(candidate)
        except Exception:
            break

        if decoded == candidate:
            break
        candidate = decoded

    return None


def _origin_link_from_query(parsed) -> str:
    for key, value in parse_qsl(parsed.query, keep_blank_values=True):
        if key.lower() == "origin_link":
            return (value or "").strip()
    return ""


def _normalize_shopee_product_url(one_url: str, depth: int = 0) -> Optional[str]:
    if depth > MAX_REDIRECT_DEPTH:
        return None

    parsed = urlparse(one_url)
    host = _normalize_host(parsed.hostname or "")
    path = parsed.path or "/"

    if _is_short_shopee_host(host):
        if _is_affiliate_redirect_path(path):
            origin_raw = _origin_link_from_query(parsed)
            origin_url = _parse_possibly_encoded_http_url(origin_raw)
            if not origin_url:
                return None
            return _normalize_shopee_product_url(origin_url, depth + 1)

        token = path.lstrip("/").split("/")[0]
        if token:
            return one_url
        return None

    if _is_shopee_market_host(host):
        if _is_direct_product_path(path):
            return one_url

        if _is_affiliate_redirect_path(path):
            origin_raw = _origin_link_from_query(parsed)
            origin_url = _parse_possibly_encoded_http_url(origin_raw)
            if not origin_url:
                return None
            return _normalize_shopee_product_url(origin_url, depth + 1)
        return None

    return None


def normalize_single_shopee_url(raw_text: Optional[str]) -> str:
    """Validate strict single-link input (no bulk, no extra text)."""
    value = (raw_text or "").strip()
    if not value:
        raise ValueError("Thiếu url.")

    if len(value) > MAX_URL_LENGTH:
        raise ValueError("URL quá dài.")

    urls = extract_urls(value)
    if len(urls) == 0:
        raise ValueError("Vui lòng dán link đầy đủ bắt đầu bằng http/https.")
    if len(urls) > 1:
        raise ValueError("Chỉ cho phép 1 link mỗi lần convert.")

    one_url = urls[0].strip()
    if one_url != value:
        raise ValueError("Chỉ dán đúng 1 link, không kèm nội dung khác.")

    parsed = urlparse(one_url)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("Vui lòng dùng link http/https.")

    normalized = _normalize_shopee_product_url(one_url, depth=0)
    if not normalized:
        raise ValueError("Chỉ hỗ trợ link sản phẩm Shopee hợp lệ.")

    return normalized


def client_ip_from_request(request: Request) -> str:
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        return xff.split(",")[0].strip() or "unknown"

    if request.client and request.client.host:
        return request.client.host

    return "unknown"


# -----------------------------
# Rate limit state + cleanup
# -----------------------------

_RATE_LIMIT_STATE: Dict[str, Deque[float]] = {}
_RATE_LIMIT_LOCK = threading.Lock()


def allow_user_request(ip: str) -> bool:
    now_ts = time.time()
    cutoff = now_ts - USER_RATE_LIMIT_WINDOW_SEC

    with _RATE_LIMIT_LOCK:
        q = _RATE_LIMIT_STATE.get(ip)
        if q is None:
            q = deque()
            _RATE_LIMIT_STATE[ip] = q

        while q and q[0] < cutoff:
            q.popleft()

        if len(q) >= USER_RATE_LIMIT_MAX:
            return False

        q.append(now_ts)
        return True


def cleanup_rate_limit_state() -> int:
    """Remove expired IP buckets to avoid unbounded memory growth."""
    now_ts = time.time()
    cutoff = now_ts - USER_RATE_LIMIT_WINDOW_SEC
    removed = 0

    with _RATE_LIMIT_LOCK:
        for ip, q in list(_RATE_LIMIT_STATE.items()):
            while q and q[0] < cutoff:
                q.popleft()
            if not q:
                del _RATE_LIMIT_STATE[ip]
                removed += 1

    return removed


# -----------------------------
# SQLite helpers
# -----------------------------


class QueueOverloadedError(Exception):
    pass


def db_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 5000;")
    conn.execute("PRAGMA synchronous = NORMAL;")
    return conn


def init_db() -> None:
    db_dir = os.path.dirname(DB_PATH)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)

    conn = db_conn()
    try:
        # WAL reduces lock contention between read-polling and write updates.
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS jobs (
              id TEXT PRIMARY KEY,
              input_url TEXT NOT NULL,
              output_url TEXT,
              status TEXT NOT NULL,
              error TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              picked_at TEXT,
              finished_at TEXT
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at)")
        conn.commit()
    finally:
        conn.close()


def create_job_in_db(input_url: str) -> str:
    conn = db_conn()
    try:
        pending_count = conn.execute(
            "SELECT COUNT(*) AS c FROM jobs WHERE status='pending'"
        ).fetchone()["c"]

        if pending_count >= MAX_PENDING_JOBS:
            raise QueueOverloadedError("Hệ thống đang quá tải, vui lòng thử lại sau ít phút.")

        job_id = str(uuid.uuid4())
        now = now_iso()
        conn.execute(
            "INSERT INTO jobs(id,input_url,status,created_at,updated_at) VALUES(?,?,?,?,?)",
            (job_id, input_url, "pending", now, now),
        )
        conn.commit()
        return job_id
    finally:
        conn.close()


def get_job_from_db(job_id: str) -> Optional[dict]:
    conn = db_conn()
    try:
        row = conn.execute(
            "SELECT id,input_url,output_url,status,error,created_at,updated_at,finished_at FROM jobs WHERE id=?",
            (job_id,),
        ).fetchone()
    finally:
        conn.close()

    if not row:
        return None

    return {
        "jobId": row["id"],
        "inputUrl": row["input_url"],
        "outputUrl": row["output_url"],
        "status": row["status"],
        "error": row["error"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "finishedAt": row["finished_at"],
    }


def fetch_next_pending_job() -> Optional[dict]:
    """Atomically pick one pending job for worker."""
    conn = db_conn()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT id,input_url FROM jobs WHERE status='pending' ORDER BY created_at ASC LIMIT 1"
        ).fetchone()

        if not row:
            conn.commit()
            return None

        now = now_iso()
        updated = conn.execute(
            "UPDATE jobs SET status='processing', picked_at=?, updated_at=? WHERE id=? AND status='pending'",
            (now, now, row["id"]),
        ).rowcount

        conn.commit()

        if updated == 0:
            return None

        return {"jobId": row["id"], "url": row["input_url"]}
    finally:
        conn.close()


def mark_job_done(job_id: str, aff_link: str) -> bool:
    conn = db_conn()
    try:
        now = now_iso()
        updated = conn.execute(
            """
            UPDATE jobs
            SET status='done', output_url=?, error=NULL, finished_at=?, updated_at=?
            WHERE id=? AND status='processing'
            """,
            (aff_link, now, now, job_id),
        ).rowcount
        conn.commit()
        return updated > 0
    finally:
        conn.close()


def mark_job_failed(job_id: str, error_message: str) -> bool:
    conn = db_conn()
    try:
        now = now_iso()
        updated = conn.execute(
            """
            UPDATE jobs
            SET status='failed', error=?, finished_at=?, updated_at=?
            WHERE id=? AND status='processing'
            """,
            (error_message, now, now, job_id),
        ).rowcount
        conn.commit()
        return updated > 0
    finally:
        conn.close()


def cleanup_old_jobs() -> int:
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=JOB_RETENTION_HOURS)).replace(microsecond=0).isoformat()
    conn = db_conn()
    try:
        deleted = conn.execute("DELETE FROM jobs WHERE created_at < ?", (cutoff,)).rowcount
        conn.commit()
        return deleted
    finally:
        conn.close()


# -----------------------------
# Pydantic models
# -----------------------------


class CreateJobRequest(BaseModel):
    url: str = Field(..., description="Single Shopee URL")


class WorkerCompleteRequest(BaseModel):
    affLink: str = Field(..., min_length=1)


class WorkerFailRequest(BaseModel):
    error: Optional[str] = None


# -----------------------------
# Background tasks
# -----------------------------


async def rate_limit_cleanup_loop(stop_event: asyncio.Event) -> None:
    while True:
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=RATE_LIMIT_CLEANUP_INTERVAL_SEC)
            break
        except asyncio.TimeoutError:
            pass
        cleanup_rate_limit_state()


async def old_jobs_cleanup_loop(stop_event: asyncio.Event) -> None:
    while True:
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=JOB_CLEANUP_INTERVAL_SEC)
            break
        except asyncio.TimeoutError:
            pass
        await asyncio.to_thread(cleanup_old_jobs)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await asyncio.to_thread(init_db)

    stop_event = asyncio.Event()
    tasks = [
        asyncio.create_task(rate_limit_cleanup_loop(stop_event)),
        asyncio.create_task(old_jobs_cleanup_loop(stop_event)),
    ]

    try:
        yield
    finally:
        stop_event.set()
        await asyncio.gather(*tasks, return_exceptions=True)


# -----------------------------
# FastAPI app
# -----------------------------


app = FastAPI(title="Shopee Converter Backend", version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=parse_allowed_origins(ALLOWED_ORIGINS_RAW),
    allow_origin_regex=(ALLOWED_ORIGIN_REGEX or None),
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "X-Worker-Key"],
)


@app.middleware("http")
async def disable_cache_for_api(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/api/"):
        # Prevent browser/proxy caching of polling endpoints (job status).
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


@app.exception_handler(HTTPException)
async def http_exception_handler(_: Request, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(_: Request, exc: RequestValidationError):
    message = "Payload không hợp lệ."
    if exc.errors():
        first = exc.errors()[0]
        loc = ".".join(str(p) for p in first.get("loc", []))
        msg = first.get("msg", "invalid")
        message = f"{message} ({loc}: {msg})"
    return JSONResponse(status_code=422, content={"error": message})


def require_worker_key(x_worker_key: str = Header(default="", alias="X-Worker-Key")) -> None:
    if not x_worker_key or not secrets.compare_digest(x_worker_key, WORKER_KEY):
        raise HTTPException(status_code=401, detail="Unauthorized worker.")


@app.get("/api/health")
async def health() -> dict:
    return {"ok": True, "time": now_iso()}


@app.post("/api/jobs", status_code=201)
async def create_job(payload: CreateJobRequest, request: Request) -> dict:
    ip = client_ip_from_request(request)
    if not allow_user_request(ip):
        raise HTTPException(status_code=429, detail="Bạn thao tác quá nhanh, vui lòng thử lại sau.")

    try:
        normalized = normalize_single_shopee_url(payload.url)
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err

    try:
        job_id = await asyncio.to_thread(create_job_in_db, normalized)
    except QueueOverloadedError as err:
        raise HTTPException(status_code=503, detail=str(err)) from err

    return {"jobId": job_id, "status": "pending"}


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str) -> dict:
    row = await asyncio.to_thread(get_job_from_db, job_id)
    if not row:
        raise HTTPException(status_code=404, detail="Job không tồn tại.")
    return row


@app.get("/api/worker/jobs/next")
async def worker_next(x_worker_key: str = Header(default="", alias="X-Worker-Key")) -> dict:
    require_worker_key(x_worker_key)

    # Retry few times for rare race where another worker picked the row first.
    for _ in range(3):
        job = await asyncio.to_thread(fetch_next_pending_job)
        if job:
            return {"job": job}
    return {"job": None}


@app.post("/api/worker/jobs/{job_id}/complete")
async def worker_complete(job_id: str, payload: WorkerCompleteRequest, x_worker_key: str = Header(default="", alias="X-Worker-Key")) -> dict:
    require_worker_key(x_worker_key)

    aff_link = (payload.affLink or "").strip()
    if not aff_link:
        raise HTTPException(status_code=400, detail="Thiếu affLink.")

    ok = await asyncio.to_thread(mark_job_done, job_id, aff_link)
    if not ok:
        raise HTTPException(status_code=409, detail="Job không ở trạng thái processing hoặc không tồn tại.")

    return {"ok": True}


@app.post("/api/worker/jobs/{job_id}/fail")
async def worker_fail(job_id: str, payload: WorkerFailRequest, x_worker_key: str = Header(default="", alias="X-Worker-Key")) -> dict:
    require_worker_key(x_worker_key)

    error_message = (payload.error or "Convert thất bại.").strip()
    ok = await asyncio.to_thread(mark_job_failed, job_id, error_message)
    if not ok:
        raise HTTPException(status_code=409, detail="Job không ở trạng thái processing hoặc không tồn tại.")

    return {"ok": True}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT)
