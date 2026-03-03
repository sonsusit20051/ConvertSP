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
from pathlib import Path
from typing import Deque, Dict, Optional
from urllib.parse import parse_qsl, unquote, urlparse
from urllib.request import Request as UrlRequest
from urllib.request import urlopen
from urllib.error import HTTPError, URLError

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

# -----------------------------
# Environment / configuration
# -----------------------------

DB_PATH = os.environ.get("DB_PATH", "backend/jobs.db")
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8787"))
WORKER_KEY = os.environ.get("WORKER_KEY", "change-me-worker-key")
ADMIN_LOGIN_KEY = os.environ.get("ADMIN_LOGIN_KEY", "24092005")
ADMIN_SESSION_TTL_SEC = int(os.environ.get("ADMIN_SESSION_TTL_SEC", "43200"))
ADMIN_SESSION_COOKIE = "admin_session"

MAX_PENDING_JOBS = int(os.environ.get("MAX_PENDING_JOBS", "2000"))
MAX_URL_LENGTH = int(os.environ.get("MAX_URL_LENGTH", "2048"))

USER_RATE_LIMIT_WINDOW_SEC = int(os.environ.get("USER_RATE_LIMIT_WINDOW_SEC", "10"))
USER_RATE_LIMIT_MAX = int(os.environ.get("USER_RATE_LIMIT_MAX", "6"))
RATE_LIMIT_CLEANUP_INTERVAL_SEC = int(os.environ.get("RATE_LIMIT_CLEANUP_INTERVAL_SEC", "60"))

JOB_RETENTION_HOURS = int(os.environ.get("JOB_RETENTION_HOURS", "24"))
JOB_CLEANUP_INTERVAL_SEC = int(os.environ.get("JOB_CLEANUP_INTERVAL_SEC", "300"))
WORKER_AVAILABILITY_TTL_SEC = int(os.environ.get("WORKER_AVAILABILITY_TTL_SEC", "30"))

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
ADMIN_UI_PATH = Path(__file__).resolve().parent / "admin" / "index.html"
ALLOWED_SOURCES = {"fb", "yt"}


# -----------------------------
# Utilities
# -----------------------------


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def parse_iso_utc(value: Optional[str]) -> Optional[datetime]:
    raw = (value or "").strip()
    if not raw:
        return None
    normalized = raw.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


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


def _extract_product_ids_from_path(path: str) -> Optional[dict]:
    value = path or "/"
    match = re.search(r"-i\.(\d+)\.(\d+)/?$", value, flags=re.IGNORECASE)
    if match:
        return {"shopId": match.group(1), "itemId": match.group(2)}

    match = re.match(r"^/product/(\d+)/(\d+)/?$", value, flags=re.IGNORECASE)
    if match:
        return {"shopId": match.group(1), "itemId": match.group(2)}

    match = re.match(r"^/universal-link/product/(\d+)/(\d+)/?$", value, flags=re.IGNORECASE)
    if match:
        return {"shopId": match.group(1), "itemId": match.group(2)}

    match = re.match(r"^/[^/]+/(\d+)/(\d+)/?$", value, flags=re.IGNORECASE)
    if match:
        return {"shopId": match.group(1), "itemId": match.group(2)}

    return None


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


def extract_product_ids_from_url(one_url: str, depth: int = 0) -> Optional[dict]:
    if depth > MAX_REDIRECT_DEPTH:
        return None

    parsed = urlparse(one_url)
    host = _normalize_host(parsed.hostname or "")
    path = parsed.path or "/"
    ids = _extract_product_ids_from_path(path)
    if ids:
        return ids

    if _is_affiliate_redirect_path(path):
        origin_raw = _origin_link_from_query(parsed)
        origin_url = _parse_possibly_encoded_http_url(origin_raw)
        if origin_url:
            return extract_product_ids_from_url(origin_url, depth + 1)

    if _is_short_shopee_host(host):
        return None

    return None


def resolve_final_url(one_url: str) -> Optional[str]:
    try:
        req = UrlRequest(
            one_url,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/124.0.0.0 Safari/537.36"
                )
            },
            method="GET",
        )
        with urlopen(req, timeout=12) as res:
            final_url = res.geturl() or one_url
            return final_url
    except HTTPError as err:
        final_url = err.geturl() if hasattr(err, "geturl") else ""
        return final_url or None
    except URLError:
        return None
    except Exception:
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


def normalize_source(raw_source: Optional[str]) -> str:
    candidate = (raw_source or "fb").strip().lower()
    if candidate not in ALLOWED_SOURCES:
        return "fb"
    return candidate


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
_ADMIN_SESSIONS: Dict[str, float] = {}
_ADMIN_SESSIONS_LOCK = threading.Lock()


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


def cleanup_admin_sessions() -> int:
    now_ts = time.time()
    removed = 0
    with _ADMIN_SESSIONS_LOCK:
        for session_id, expiry in list(_ADMIN_SESSIONS.items()):
            if expiry <= now_ts:
                del _ADMIN_SESSIONS[session_id]
                removed += 1
    return removed


def create_admin_session() -> str:
    cleanup_admin_sessions()
    session_id = secrets.token_urlsafe(32)
    expires_at = time.time() + max(300, ADMIN_SESSION_TTL_SEC)
    with _ADMIN_SESSIONS_LOCK:
        _ADMIN_SESSIONS[session_id] = expires_at
    return session_id


def is_admin_session_valid(session_id: str) -> bool:
    if not session_id:
        return False
    cleanup_admin_sessions()
    with _ADMIN_SESSIONS_LOCK:
        expiry = _ADMIN_SESSIONS.get(session_id)
        if not expiry:
            return False
        if expiry <= time.time():
            del _ADMIN_SESSIONS[session_id]
            return False
    return True


def delete_admin_session(session_id: str) -> None:
    if not session_id:
        return
    with _ADMIN_SESSIONS_LOCK:
        _ADMIN_SESSIONS.pop(session_id, None)


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
              source TEXT NOT NULL DEFAULT 'fb',
              requester_ip TEXT NOT NULL DEFAULT 'unknown',
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
        cols = {row["name"] for row in conn.execute("PRAGMA table_info(jobs)").fetchall()}
        if "source" not in cols:
            conn.execute("ALTER TABLE jobs ADD COLUMN source TEXT NOT NULL DEFAULT 'fb'")
        if "requester_ip" not in cols:
            conn.execute("ALTER TABLE jobs ADD COLUMN requester_ip TEXT NOT NULL DEFAULT 'unknown'")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS extension_metrics (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              dashboard_reload_count INTEGER NOT NULL DEFAULT 0,
              dashboard_reload_cycles INTEGER NOT NULL DEFAULT 0,
              last_dashboard_reload_at TEXT,
              updated_at TEXT NOT NULL
            )
            """
        )
        ext_cols = {row["name"] for row in conn.execute("PRAGMA table_info(extension_metrics)").fetchall()}
        if "dashboard_reload_count" not in ext_cols:
            conn.execute("ALTER TABLE extension_metrics ADD COLUMN dashboard_reload_count INTEGER NOT NULL DEFAULT 0")
        if "dashboard_reload_cycles" not in ext_cols:
            conn.execute("ALTER TABLE extension_metrics ADD COLUMN dashboard_reload_cycles INTEGER NOT NULL DEFAULT 0")
        if "last_dashboard_reload_at" not in ext_cols:
            conn.execute("ALTER TABLE extension_metrics ADD COLUMN last_dashboard_reload_at TEXT")
        if "updated_at" not in ext_cols:
            conn.execute("ALTER TABLE extension_metrics ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''")
        conn.execute(
            """
            INSERT OR IGNORE INTO extension_metrics (
              id,
              dashboard_reload_count,
              dashboard_reload_cycles,
              last_dashboard_reload_at,
              updated_at
            ) VALUES (1, 0, 0, NULL, ?)
            """,
            (now_iso(),),
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS worker_runtime (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              is_connected INTEGER NOT NULL DEFAULT 0,
              last_ping_at TEXT,
              updated_at TEXT NOT NULL
            )
            """
        )
        worker_cols = {row["name"] for row in conn.execute("PRAGMA table_info(worker_runtime)").fetchall()}
        if "is_connected" not in worker_cols:
            conn.execute("ALTER TABLE worker_runtime ADD COLUMN is_connected INTEGER NOT NULL DEFAULT 0")
        if "last_ping_at" not in worker_cols:
            conn.execute("ALTER TABLE worker_runtime ADD COLUMN last_ping_at TEXT")
        if "updated_at" not in worker_cols:
            conn.execute("ALTER TABLE worker_runtime ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''")
        conn.execute(
            """
            INSERT OR IGNORE INTO worker_runtime (
              id,
              is_connected,
              last_ping_at,
              updated_at
            ) VALUES (1, 0, NULL, ?)
            """,
            (now_iso(),),
        )
        conn.commit()
    finally:
        conn.close()


def create_job_in_db(input_url: str, requester_ip: str, source: str) -> str:
    conn = db_conn()
    try:
        pending_count = conn.execute(
            "SELECT COUNT(*) AS c FROM jobs WHERE status='pending'"
        ).fetchone()["c"]

        if pending_count >= MAX_PENDING_JOBS:
            raise QueueOverloadedError("Hệ thống đang quá tải, vui lòng thử lại sau ít phút.")

        job_id = str(uuid.uuid4())
        now = now_iso()
        normalized_source = normalize_source(source)
        conn.execute(
            "INSERT INTO jobs(id,input_url,source,requester_ip,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
            (job_id, input_url, normalized_source, requester_ip or "unknown", "pending", now, now),
        )
        conn.commit()
        return job_id
    finally:
        conn.close()


def get_job_from_db(job_id: str) -> Optional[dict]:
    conn = db_conn()
    try:
        row = conn.execute(
            "SELECT id,input_url,source,output_url,status,error,created_at,updated_at,finished_at FROM jobs WHERE id=?",
            (job_id,),
        ).fetchone()
    finally:
        conn.close()

    if not row:
        return None

    return {
        "jobId": row["id"],
        "inputUrl": row["input_url"],
        "source": normalize_source(row["source"] if "source" in row.keys() else "fb"),
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


def get_admin_stats_from_db() -> dict:
    conn = db_conn()
    try:
        totals = conn.execute(
            """
            SELECT
              COUNT(*) AS total_requests,
              SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending_count,
              SUM(CASE WHEN status='processing' THEN 1 ELSE 0 END) AS processing_count,
              SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS done_count,
              SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed_count,
              SUM(CASE WHEN source='fb' THEN 1 ELSE 0 END) AS source_fb_count,
              SUM(CASE WHEN source='yt' THEN 1 ELSE 0 END) AS source_yt_count
            FROM jobs
            """
        ).fetchone()

        today_prefix = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        today_requests = conn.execute(
            "SELECT COUNT(*) AS c FROM jobs WHERE created_at LIKE ?",
            (f"{today_prefix}%",),
        ).fetchone()["c"]

        last_24h_cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).replace(microsecond=0).isoformat()
        last_24h_requests = conn.execute(
            "SELECT COUNT(*) AS c FROM jobs WHERE created_at >= ?",
            (last_24h_cutoff,),
        ).fetchone()["c"]
        ext_metrics = conn.execute(
            """
            SELECT
              dashboard_reload_count,
              dashboard_reload_cycles,
              last_dashboard_reload_at,
              updated_at
            FROM extension_metrics
            WHERE id = 1
            """
        ).fetchone()
    finally:
        conn.close()

    dashboard_reload_count = int((ext_metrics["dashboard_reload_count"] if ext_metrics else 0) or 0)
    dashboard_reload_cycles = int((ext_metrics["dashboard_reload_cycles"] if ext_metrics else 0) or 0)
    last_dashboard_reload_at = ext_metrics["last_dashboard_reload_at"] if ext_metrics else None
    last_dashboard_metric_update_at = ext_metrics["updated_at"] if ext_metrics else None

    return {
        "totalRequests": int(totals["total_requests"] or 0),
        "pendingCount": int(totals["pending_count"] or 0),
        "processingCount": int(totals["processing_count"] or 0),
        "doneCount": int(totals["done_count"] or 0),
        "failedCount": int(totals["failed_count"] or 0),
        "sourceFbCount": int(totals["source_fb_count"] or 0),
        "sourceYtCount": int(totals["source_yt_count"] or 0),
        "todayRequests": int(today_requests or 0),
        "last24hRequests": int(last_24h_requests or 0),
        "dashboardReloadCount": dashboard_reload_count,
        "dashboardReloadCycles": dashboard_reload_cycles,
        "lastDashboardReloadAt": last_dashboard_reload_at,
        "lastDashboardMetricUpdateAt": last_dashboard_metric_update_at,
    }


def append_worker_reload_metrics(reloaded_tabs: int, cycle_count: int, last_reload_at: Optional[str]) -> None:
    safe_tabs = max(0, int(reloaded_tabs or 0))
    safe_cycles = max(0, int(cycle_count or 0))
    now = now_iso()
    effective_last_reload_at = (last_reload_at or "").strip() or now

    conn = db_conn()
    try:
        conn.execute(
            """
            INSERT OR IGNORE INTO extension_metrics (
              id,
              dashboard_reload_count,
              dashboard_reload_cycles,
              last_dashboard_reload_at,
              updated_at
            ) VALUES (1, 0, 0, NULL, ?)
            """,
            (now,),
        )
        conn.execute(
            """
            UPDATE extension_metrics
            SET
              dashboard_reload_count = dashboard_reload_count + ?,
              dashboard_reload_cycles = dashboard_reload_cycles + ?,
              last_dashboard_reload_at = ?,
              updated_at = ?
            WHERE id = 1
            """,
            (safe_tabs, safe_cycles, effective_last_reload_at, now),
        )
        conn.commit()
    finally:
        conn.close()


def update_worker_runtime(connected: bool, ping_at: Optional[str] = None) -> None:
    now = now_iso()
    effective_ping = (ping_at or "").strip() or now
    conn = db_conn()
    try:
        conn.execute(
            """
            INSERT OR IGNORE INTO worker_runtime (
              id,
              is_connected,
              last_ping_at,
              updated_at
            ) VALUES (1, 0, NULL, ?)
            """,
            (now,),
        )
        conn.execute(
            """
            UPDATE worker_runtime
            SET
              is_connected = ?,
              last_ping_at = ?,
              updated_at = ?
            WHERE id = 1
            """,
            (1 if connected else 0, effective_ping, now),
        )
        conn.commit()
    finally:
        conn.close()


def get_worker_availability() -> dict:
    conn = db_conn()
    try:
        row = conn.execute(
            "SELECT is_connected, last_ping_at, updated_at FROM worker_runtime WHERE id = 1"
        ).fetchone()
    finally:
        conn.close()

    is_connected = bool(int((row["is_connected"] if row else 0) or 0))
    last_ping_at = row["last_ping_at"] if row else None
    updated_at = row["updated_at"] if row else None

    ping_dt = parse_iso_utc(last_ping_at)
    stale_sec = None
    online = False
    if ping_dt is not None:
        stale_sec = max(0, int((datetime.now(timezone.utc) - ping_dt).total_seconds()))
        online = is_connected and stale_sec <= max(5, WORKER_AVAILABILITY_TTL_SEC)

    return {
        "online": bool(online),
        "connected": bool(is_connected),
        "lastPingAt": last_ping_at,
        "updatedAt": updated_at,
        "staleSec": stale_sec,
        "ttlSec": max(5, WORKER_AVAILABILITY_TTL_SEC),
    }


def get_admin_requests_from_db(limit: int = 200) -> list[dict]:
    safe_limit = max(1, min(int(limit or 200), 1000))
    conn = db_conn()
    try:
        rows = conn.execute(
            """
            SELECT
              id,
              input_url,
              source,
              output_url,
              requester_ip,
              status,
              error,
              created_at,
              updated_at,
              finished_at
            FROM jobs
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (safe_limit,),
        ).fetchall()
    finally:
        conn.close()

    return [
        {
            "jobId": row["id"],
            "inputUrl": row["input_url"],
            "source": normalize_source(row["source"] if "source" in row.keys() else "fb"),
            "outputUrl": row["output_url"],
            "ip": row["requester_ip"] or "unknown",
            "status": row["status"],
            "error": row["error"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
            "finishedAt": row["finished_at"],
        }
        for row in rows
    ]


# -----------------------------
# Pydantic models
# -----------------------------


class CreateJobRequest(BaseModel):
    url: str = Field(..., description="Single Shopee URL")
    source: Optional[str] = Field(default="fb", description="Traffic source: fb|yt")


class WorkerCompleteRequest(BaseModel):
    affLink: str = Field(..., min_length=1)


class WorkerFailRequest(BaseModel):
    error: Optional[str] = None


class WorkerReloadMetricRequest(BaseModel):
    reloadedTabs: int = Field(default=0, ge=0, le=100)
    cycleCount: int = Field(default=1, ge=0, le=50)
    lastReloadAt: Optional[str] = None


class WorkerPingRequest(BaseModel):
    connected: bool = True
    pingAt: Optional[str] = None


class AdminLoginRequest(BaseModel):
    key: str = Field(..., min_length=1, max_length=128)


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


def require_admin_session(request: Request) -> str:
    session_id = (request.cookies.get(ADMIN_SESSION_COOKIE) or "").strip()
    if not is_admin_session_valid(session_id):
        raise HTTPException(status_code=401, detail="Admin chưa đăng nhập.")
    return session_id


@app.get("/admin")
async def admin_ui() -> FileResponse:
    if not ADMIN_UI_PATH.exists():
        raise HTTPException(status_code=500, detail="Thiếu giao diện admin.")
    return FileResponse(str(ADMIN_UI_PATH))


@app.post("/api/admin/login")
async def admin_login(payload: AdminLoginRequest) -> JSONResponse:
    submitted = (payload.key or "").strip()
    if not submitted or not secrets.compare_digest(submitted, ADMIN_LOGIN_KEY):
        raise HTTPException(status_code=401, detail="Sai key đăng nhập admin.")

    session_id = create_admin_session()
    response = JSONResponse({"ok": True})
    response.set_cookie(
        key=ADMIN_SESSION_COOKIE,
        value=session_id,
        max_age=max(300, ADMIN_SESSION_TTL_SEC),
        httponly=True,
        samesite="lax",
        secure=False,
        path="/",
    )
    return response


@app.post("/api/admin/logout")
async def admin_logout(request: Request) -> JSONResponse:
    session_id = (request.cookies.get(ADMIN_SESSION_COOKIE) or "").strip()
    delete_admin_session(session_id)

    response = JSONResponse({"ok": True})
    response.delete_cookie(key=ADMIN_SESSION_COOKIE, path="/")
    return response


@app.get("/api/admin/me")
async def admin_me(request: Request) -> dict:
    require_admin_session(request)
    return {"authenticated": True}


@app.get("/api/admin/stats")
async def admin_stats(request: Request) -> dict:
    require_admin_session(request)
    stats = await asyncio.to_thread(get_admin_stats_from_db)
    return {"stats": stats}


@app.get("/api/admin/requests")
async def admin_requests(request: Request, limit: int = 200) -> dict:
    require_admin_session(request)
    items = await asyncio.to_thread(get_admin_requests_from_db, limit)
    return {"items": items, "count": len(items)}


@app.get("/api/health")
async def health() -> dict:
    return {"ok": True, "time": now_iso()}


@app.get("/api/worker/availability")
async def worker_availability() -> dict:
    availability = await asyncio.to_thread(get_worker_availability)
    return availability


@app.get("/api/resolve-product-ids")
async def resolve_product_ids(url: str) -> dict:
    try:
        normalized = normalize_single_shopee_url(url)
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err

    resolved_url = normalized
    ids = extract_product_ids_from_url(normalized, depth=0)
    if not ids:
        final_url = await asyncio.to_thread(resolve_final_url, normalized)
        if final_url:
            resolved_url = final_url
            ids = extract_product_ids_from_url(final_url, depth=0)

    if not ids:
        raise HTTPException(status_code=422, detail="Không tách được shop_id/item_id từ link này.")

    return {
        "shopId": ids["shopId"],
        "itemId": ids["itemId"],
        "resolvedUrl": resolved_url,
    }


@app.post("/api/jobs", status_code=201)
async def create_job(payload: CreateJobRequest, request: Request) -> dict:
    ip = client_ip_from_request(request)
    if not allow_user_request(ip):
        raise HTTPException(status_code=429, detail="Bạn thao tác quá nhanh, vui lòng thử lại sau.")

    source = normalize_source(payload.source)

    try:
        normalized = normalize_single_shopee_url(payload.url)
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err

    try:
        job_id = await asyncio.to_thread(create_job_in_db, normalized, ip, source)
    except QueueOverloadedError as err:
        raise HTTPException(status_code=503, detail=str(err)) from err

    return {"jobId": job_id, "status": "pending", "source": source}


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str) -> dict:
    row = await asyncio.to_thread(get_job_from_db, job_id)
    if not row:
        raise HTTPException(status_code=404, detail="Job không tồn tại.")
    return row


@app.post("/api/worker/ping")
async def worker_ping(payload: WorkerPingRequest, x_worker_key: str = Header(default="", alias="X-Worker-Key")) -> dict:
    require_worker_key(x_worker_key)
    await asyncio.to_thread(update_worker_runtime, bool(payload.connected), payload.pingAt)
    return {"ok": True}


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


@app.post("/api/worker/metrics/reload")
async def worker_metric_reload(payload: WorkerReloadMetricRequest, x_worker_key: str = Header(default="", alias="X-Worker-Key")) -> dict:
    require_worker_key(x_worker_key)

    await asyncio.to_thread(
        append_worker_reload_metrics,
        payload.reloadedTabs,
        payload.cycleCount,
        payload.lastReloadAt,
    )
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT)
