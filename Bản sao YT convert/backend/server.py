#!/usr/bin/env python3
import json
import os
import re
import secrets
import string
import threading
import time
import uuid
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

PORT = int(os.getenv("PORT", "8787"))
WORKER_TOKEN = os.getenv("WORKER_TOKEN", "dev-worker-token")
JOB_TTL_SEC = int(os.getenv("JOB_TTL_SEC", "300"))
JOB_PROCESS_TIMEOUT_SEC = int(os.getenv("JOB_PROCESS_TIMEOUT_SEC", "120"))
WORKER_STALE_SEC = int(os.getenv("WORKER_STALE_SEC", "60"))
MAX_BODY_BYTES = 1024 * 1024
SYNC_WAIT_TIMEOUT_SEC = int(os.getenv("SYNC_WAIT_TIMEOUT_SEC", "90"))
SYNC_WAIT_POLL_MS = int(os.getenv("SYNC_WAIT_POLL_MS", "220"))
SHORT_CODE_LEN = int(os.getenv("SHORT_CODE_LEN", "4"))
SHORT_TTL_SEC = int(os.getenv("SHORT_TTL_SEC", "604800"))
SHORT_PUBLIC_BASE = os.getenv("SHORT_PUBLIC_BASE", "").strip()
SUB_ID_YT = os.getenv("SUB_ID_YT", "YT3")
DEFAULT_AFFILIATE_ID = os.getenv("DEFAULT_AFFILIATE_ID", "17391540096").strip()
FORCED_AFFILIATE_ID = os.getenv("FORCED_AFFILIATE_ID", "").strip()
BASE_REDIRECT = os.getenv("BASE_REDIRECT", "https://s.shopee.vn/an_redir").strip()
FORCE_YT_MODE = os.getenv("FORCE_YT_MODE", "1") == "1"
ADMIN_STATS_KEY = os.getenv("ADMIN_STATS_KEY", "").strip()

URL_CANDIDATE_REGEX = re.compile(
    r"((?:https?://)?(?:[a-z0-9-]+\.)*(?:shopee\.[a-z.]{2,}|shope\.ee|shp\.ee)(?:/[^\s<>\"']*)?)",
    re.IGNORECASE,
)

JOBS = {}
PENDING_QUEUE = []
WORKERS = {}
SHORT_LINKS = {}
REQUEST_STATS = {}
STORE_LOCK = threading.Lock()


def now_ts() -> int:
    return int(time.time())


def today_key_local() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def trim_trailing_punctuation(text: str) -> str:
    return re.sub(r"[),.;!?\\]\\s]+$", "", text)


def ensure_protocol(text: str) -> str:
    if text.lower().startswith(("http://", "https://")):
        return text
    return f"https://{text}"


def extract_link_candidates(raw_text: str):
    if not raw_text:
        return []
    return [trim_trailing_punctuation(m.group(1)) for m in URL_CANDIDATE_REGEX.finditer(str(raw_text))]


def is_allowed_host(hostname: str) -> bool:
    host = (hostname or "").lower()
    if host == "shope.ee":
        return True
    if re.match(r"^([a-z0-9-]+\.)*shp\.ee$", host, re.IGNORECASE):
        return True
    if re.match(r"^([a-z0-9-]+\.)*shopee\.[a-z.]{2,}$", host, re.IGNORECASE):
        return True
    return False


def is_shortlink_host(hostname: str) -> bool:
    host = (hostname or "").lower()
    return host in ("shope.ee", "shp.ee") or host.endswith(".shp.ee") or host.startswith("s.shopee.")


def is_shopee_landing_host(hostname: str) -> bool:
    host = (hostname or "").lower()
    return bool(re.match(r"^([a-z0-9-]+\.)*shopee\.[a-z.]{2,}$", host, re.IGNORECASE))


def is_supported_shopee_path(parsed_url):
    path = str(parsed_url.path or "/")
    host = str(parsed_url.hostname or "").lower()

    if is_shortlink_host(host):
        return bool(path and path != "/" and len(path) > 1)

    if not is_shopee_landing_host(host):
        return False

    patterns = [
        r"^/product/\d+/\d+/?$",
        r"^/.+-i\.\d+\.\d+/?$",
        r"^/shop/\d+/?$",
        r"^/[^/?#]+/?$",
        r"^/.+-cat\.\d+/?$",
        r"^/search/?$",
        r"^/m/voucher(?:-shop)?(?:/[^/?#]+)?/?$",
        r"^/m/[^/?#]+/?$",
        r"^/flash_sale/?$",
        r"^/cart/?$",
    ]
    return any(re.match(pattern, path, re.IGNORECASE) for pattern in patterns)


def extract_product_ids(path: str):
    full_path = str(path or "")

    slug_match = re.search(r"-i\.(\d+)\.(\d+)(?:/)?$", full_path)
    if slug_match:
        return slug_match.group(1), slug_match.group(2)

    parts = [p for p in full_path.split("/") if p]
    if len(parts) >= 2 and parts[-1].isdigit() and parts[-2].isdigit():
        return parts[-2], parts[-1]

    return None, None


def canonicalize_landing_url(raw_url: str):
    if not raw_url:
        return None

    parsed = urlparse(str(raw_url))
    if not parsed.scheme or not parsed.netloc:
        return None

    if not is_allowed_host(parsed.hostname or ""):
        return None

    if not re.match(r"^([a-z0-9-]+\.)*shopee\.[a-z.]{2,}$", parsed.hostname or "", re.IGNORECASE):
        return None

    shop_id, item_id = extract_product_ids(parsed.path)
    if not shop_id or not item_id:
        return None

    gads_sig = ""
    for k, v in parse_qsl(parsed.query, keep_blank_values=True):
        if k.lower() == "gads_t_sig" and v:
            gads_sig = v
            break

    if not gads_sig:
        return None

    canonical = parsed._replace(
        scheme="https",
        path=f"/product/{shop_id}/{item_id}",
        query=urlencode([("gads_t_sig", gads_sig)], doseq=True),
        fragment="",
    )
    return urlunparse(canonical)


def rebuild_affiliate_link(original_affiliate_link: str, canonical_landing_url: str):
    if not original_affiliate_link or not canonical_landing_url:
        return None

    parsed = urlparse(str(original_affiliate_link))
    if not parsed.scheme or not parsed.netloc:
        return None

    affiliate_id = ""
    sub_id = ""
    for k, v in parse_qsl(parsed.query, keep_blank_values=True):
        if k == "affiliate_id" and v:
            affiliate_id = v
        elif k == "sub_id":
            sub_id = v

    if FORCED_AFFILIATE_ID:
        affiliate_id = FORCED_AFFILIATE_ID

    if not affiliate_id:
        return None

    next_query = [("affiliate_id", affiliate_id)]
    if sub_id:
        next_query.append(("sub_id", sub_id))
    next_query.append(("origin_link", canonical_landing_url))

    rebuilt = parsed._replace(query=urlencode(next_query, doseq=True), fragment="")
    return urlunparse(rebuilt)


def extract_affiliate_parts(affiliate_link: str):
    parsed = urlparse(str(affiliate_link or ""))
    if not parsed.query:
        return "", "", ""

    affiliate_id = ""
    sub_id = ""
    origin_link = ""
    for k, v in parse_qsl(parsed.query, keep_blank_values=True):
        if k == "affiliate_id":
            affiliate_id = v
        elif k == "sub_id":
            sub_id = v
        elif k == "origin_link":
            origin_link = v
    return affiliate_id, sub_id, origin_link


def build_strict_affiliate_link(origin_link_url: str, affiliate_id: str, sub_id: str):
    parsed_base = urlparse(str(BASE_REDIRECT or ""))
    if not parsed_base.scheme or not parsed_base.netloc:
        return ""

    aff = str(affiliate_id or "").strip()
    sid = str(sub_id or "").strip()
    if not aff or not sid or not origin_link_url:
        return ""

    next_query = [
        ("affiliate_id", aff),
        ("sub_id", sid),
        ("origin_link", str(origin_link_url)),
    ]
    rebuilt = parsed_base._replace(query=urlencode(next_query, doseq=True), fragment="")
    return urlunparse(rebuilt)


def choose_yt_sub_id(sub_id: str):
    sid = str(sub_id or "").strip()
    if sid and sid.upper().startswith("YT3"):
        return sid
    return SUB_ID_YT


def choose_affiliate_id(*candidates):
    if FORCED_AFFILIATE_ID:
        return FORCED_AFFILIATE_ID
    for c in candidates:
        v = str(c or "").strip()
        if v:
            return v
    return DEFAULT_AFFILIATE_ID


def override_affiliate_meta_in_affiliate_link(
    original_affiliate_link: str, next_affiliate_id: str = "", next_sub_id=None
):
    parsed = urlparse(str(original_affiliate_link or ""))
    if not parsed.scheme or not parsed.netloc:
        return original_affiliate_link

    affiliate_id = ""
    sub_id = ""
    origin_link = ""
    for k, v in parse_qsl(parsed.query, keep_blank_values=True):
        if k == "affiliate_id" and v:
            affiliate_id = v
        elif k == "sub_id":
            sub_id = v
        elif k == "origin_link" and v:
            origin_link = v

    if not origin_link:
        return original_affiliate_link

    final_affiliate_id = str(next_affiliate_id or affiliate_id or "").strip()
    if not final_affiliate_id:
        return original_affiliate_link

    if next_sub_id is None:
        final_sub_id = str(sub_id or "").strip()
    else:
        final_sub_id = str(next_sub_id or "").strip()

    next_query = [("affiliate_id", final_affiliate_id)]
    if final_sub_id:
        next_query.append(("sub_id", final_sub_id))
    next_query.append(("origin_link", origin_link))

    rebuilt = parsed._replace(query=urlencode(next_query, doseq=True), fragment="")
    return urlunparse(rebuilt)


def override_sub_id_in_affiliate_link(original_affiliate_link: str, next_sub_id: str):
    return override_affiliate_meta_in_affiliate_link(original_affiliate_link, "", next_sub_id)


def normalize_input(raw_input: str):
    trimmed = str(raw_input or "").strip()
    if not trimmed:
        return {"ok": False, "error": "Vui lòng dán link Shopee trước khi tạo link."}

    candidates = extract_link_candidates(trimmed)
    if len(candidates) > 1:
        return {"ok": False, "error": "Vui lòng chỉ dán 1 link Shopee mỗi lần."}

    extracted = candidates[0] if candidates else ""
    if not extracted:
        return {"ok": False, "error": "Không tìm thấy link Shopee hợp lệ trong nội dung bạn dán."}

    try:
        parsed = urlparse(ensure_protocol(extracted))
    except Exception:
        return {"ok": False, "error": "Link không đúng định dạng URL."}

    if not parsed.scheme or not parsed.netloc:
        return {"ok": False, "error": "Link không đúng định dạng URL."}

    if not is_allowed_host(parsed.hostname or ""):
        return {
            "ok": False,
            "error": "Domain không được hỗ trợ. Chỉ chấp nhận *.shopee.*, s.shopee.*, shope.ee và *.shp.ee.",
        }

    if not is_supported_shopee_path(parsed):
        return {
            "ok": False,
            "error": "Định dạng link chưa hỗ trợ. Hãy dùng link sản phẩm, shop, category, search, voucher, flash sale, cart hoặc shortlink Shopee.",
        }

    parsed = parsed._replace(fragment="")
    return {"ok": True, "url": parsed.geturl()}


def public_job_view(job: dict):
    view = {
        "id": job["id"],
        "status": job["status"],
        "message": job.get("message", ""),
        "createdAt": job["createdAt"],
        "updatedAt": job["updatedAt"],
    }

    if job["status"] == "success":
        view["result"] = {
            "affiliateLink": job.get("affiliateLink", ""),
            "longAffiliateLink": job.get("longAffiliateLink", ""),
            "campaignRawAffiliateLink": job.get("campaignRawAffiliateLink", ""),
            "campaignSource": job.get("campaignSource", ""),
            "campaignAffiliateId": job.get("campaignAffiliateId", ""),
            "campaignSubId": job.get("campaignSubId", ""),
            "landingUrl": job.get("landingUrl", ""),
            "cleanLandingUrl": job.get("cleanLandingUrl", ""),
            "workerId": job.get("assignedWorker", ""),
        }

    return view


def query_dict(query: str):
    data = {}
    for k, v in parse_qsl(query or "", keep_blank_values=True):
        data[k] = v
    return data


def record_convert_request(kind: str):
    day_key = today_key_local()
    kind_key = "sync" if str(kind) == "sync" else "async"
    with STORE_LOCK:
        row = REQUEST_STATS.get(day_key) or {"total": 0, "sync": 0, "async": 0}
        row["total"] = int(row.get("total", 0)) + 1
        row[kind_key] = int(row.get(kind_key, 0)) + 1
        REQUEST_STATS[day_key] = row


def request_stats_today():
    day_key = today_key_local()
    with STORE_LOCK:
        row = REQUEST_STATS.get(day_key) or {"total": 0, "sync": 0, "async": 0}
        total_all = 0
        for info in REQUEST_STATS.values():
            total_all += int((info or {}).get("total", 0))
    return {
        "date": day_key,
        "today": {
            "total": int(row.get("total", 0)),
            "sync": int(row.get("sync", 0)),
            "async": int(row.get("async", 0)),
        },
        "totalSinceStart": total_all,
    }


def is_stats_authorized(handler: BaseHTTPRequestHandler, query: dict):
    if not ADMIN_STATS_KEY:
        return True
    provided = (
        handler.headers.get("X-Admin-Key")
        or query.get("key")
        or query.get("admin_key")
        or ""
    )
    return str(provided).strip() == ADMIN_STATS_KEY


def parse_affiliate_meta(affiliate_link: str):
    affiliate_id, sub_id, _ = extract_affiliate_parts(affiliate_link)
    return affiliate_id, sub_id


def is_http_url(text: str):
    try:
        parsed = urlparse(str(text or "").strip())
        return parsed.scheme in ("http", "https") and bool(parsed.netloc)
    except Exception:
        return False


def random_code(length: int = SHORT_CODE_LEN):
    alphabet = string.ascii_letters + string.digits
    size = max(3, int(length or 4))
    return "".join(secrets.choice(alphabet) for _ in range(size))


def create_short_code(long_url: str):
    ts = now_ts()
    with STORE_LOCK:
        for _ in range(20):
            code = random_code(SHORT_CODE_LEN)
            if code not in SHORT_LINKS:
                SHORT_LINKS[code] = {"url": long_url, "createdAt": ts, "hits": 0}
                return code

        code = f"{random_code(max(SHORT_CODE_LEN, 4))}{int(time.time() % 1000)}"
        SHORT_LINKS[code] = {"url": long_url, "createdAt": ts, "hits": 0}
        return code


def get_short_target(code: str):
    if not code:
        return None

    with STORE_LOCK:
        rec = SHORT_LINKS.get(code)
        if not rec:
            return None
        rec["hits"] = int(rec.get("hits", 0)) + 1
        return rec.get("url")


def infer_base_url(handler: BaseHTTPRequestHandler):
    if SHORT_PUBLIC_BASE:
        return SHORT_PUBLIC_BASE.rstrip("/")

    host = handler.headers.get("Host", f"localhost:{PORT}")
    proto = handler.headers.get("X-Forwarded-Proto", "")
    if not proto:
        proto = "https" if str(host).endswith(":443") else "http"
    return f"{proto}://{host}"


def make_short_link(handler: BaseHTTPRequestHandler, long_url: str):
    code = create_short_code(long_url)
    base = infer_base_url(handler)
    return f"{base}/r/{code}", code


def wait_for_job_terminal(job_id: str, timeout_sec: int = SYNC_WAIT_TIMEOUT_SEC):
    deadline = time.time() + max(2, int(timeout_sec or 1))
    poll_sec = max(0.15, SYNC_WAIT_POLL_MS / 1000.0)

    while time.time() < deadline:
        cleanup_state()
        with STORE_LOCK:
            job = JOBS.get(job_id)
            if not job:
                return {"ok": False, "message": "Không tìm thấy job sau khi submit."}

            status = job.get("status")
            if status == "success":
                return {"ok": True, "job": dict(job)}
            if status in ("error", "expired"):
                return {"ok": False, "message": job.get("message") or "Job thất bại."}

        time.sleep(poll_sec)

    return {"ok": False, "message": "Timeout chờ worker xử lý."}


def cleanup_state():
    ts = now_ts()

    with STORE_LOCK:
        expired_codes = []
        for code, rec in SHORT_LINKS.items():
            if ts - int(rec.get("createdAt", ts)) > SHORT_TTL_SEC:
                expired_codes.append(code)
        for code in expired_codes:
            SHORT_LINKS.pop(code, None)

        for worker in WORKERS.values():
            if ts - worker["lastSeen"] > WORKER_STALE_SEC:
                worker["online"] = False

        for job in JOBS.values():
            if job["status"] in ("success", "error", "expired"):
                continue

            age = ts - job["createdAt"]
            if age > JOB_TTL_SEC:
                job["status"] = "expired"
                job["message"] = "Yêu cầu đã hết hạn do quá thời gian chờ worker."
                job["updatedAt"] = ts
                continue

            if job["status"] == "processing":
                run_for = ts - (job.get("startedAt") or job["updatedAt"])
                if run_for > JOB_PROCESS_TIMEOUT_SEC:
                    job["status"] = "error"
                    job["message"] = "Worker xử lý quá lâu. Vui lòng thử lại."
                    job["updatedAt"] = ts


def parse_json_body(handler: BaseHTTPRequestHandler):
    raw_length = handler.headers.get("Content-Length", "0")
    try:
        length = int(raw_length)
    except ValueError:
        raise ValueError("Content-Length không hợp lệ.")

    if length < 0 or length > MAX_BODY_BYTES:
        raise ValueError("Payload quá lớn.")

    raw = handler.rfile.read(length) if length > 0 else b"{}"
    try:
        return json.loads(raw.decode("utf-8") or "{}")
    except Exception:
        raise ValueError("Body JSON không hợp lệ.")


def require_worker_token(headers, body: dict) -> bool:
    provided = headers.get("X-Worker-Token") or body.get("workerToken") or ""
    return provided == WORKER_TOKEN


def upsert_worker(body: dict):
    ts = now_ts()
    worker_id = str(body.get("workerId") or "").strip() or f"worker-{uuid.uuid4().hex[:8]}"

    with STORE_LOCK:
        worker = WORKERS.get(worker_id) or {
            "id": worker_id,
            "name": "",
            "affiliateId": "",
            "subId": "",
            "lastSeen": ts,
            "online": True,
            "createdAt": ts,
        }

        worker["name"] = str(body.get("workerName") or worker.get("name") or worker_id)
        worker["affiliateId"] = str(body.get("affiliateId") or worker.get("affiliateId") or "")
        worker["subId"] = str(body.get("subId") or worker.get("subId") or "")
        worker["lastSeen"] = ts
        worker["online"] = True

        WORKERS[worker_id] = worker

    return worker_id


def create_job(input_raw: str, normalized_url: str):
    ts = now_ts()
    job_id = f"job_{uuid.uuid4().hex[:12]}"

    job = {
        "id": job_id,
        "input": input_raw,
        "url": normalized_url,
        "status": "queued",
        "message": "Đã nhận yêu cầu, đang chờ worker xử lý.",
        "createdAt": ts,
        "updatedAt": ts,
        "startedAt": None,
        "assignedWorker": None,
        "affiliateLink": "",
        "longAffiliateLink": "",
        "campaignRawAffiliateLink": "",
        "campaignSource": "",
        "campaignAffiliateId": "",
        "campaignSubId": "",
        "landingUrl": "",
        "cleanLandingUrl": "",
    }

    with STORE_LOCK:
        JOBS[job_id] = job
        PENDING_QUEUE.append(job_id)

    return job


def claim_next_job(worker_id: str):
    ts = now_ts()

    with STORE_LOCK:
        claimed_idx = None
        claimed_job = None

        for idx, job_id in enumerate(PENDING_QUEUE):
            job = JOBS.get(job_id)
            if not job:
                continue
            if job["status"] != "queued":
                continue
            claimed_idx = idx
            claimed_job = job
            break

        if claimed_job is None:
            return None

        PENDING_QUEUE.pop(claimed_idx)
        claimed_job["status"] = "processing"
        claimed_job["message"] = "Worker đang xử lý yêu cầu."
        claimed_job["updatedAt"] = ts
        claimed_job["startedAt"] = ts
        claimed_job["assignedWorker"] = worker_id

        return {
            "id": claimed_job["id"],
            "input": claimed_job["input"],
            "url": claimed_job["url"],
        }


def submit_job_result(body: dict):
    worker_id = str(body.get("workerId") or "").strip()
    job_id = str(body.get("jobId") or "").strip()
    success = bool(body.get("success"))

    if not worker_id or not job_id:
        return {"ok": False, "status": 400, "message": "Thiếu workerId hoặc jobId."}

    with STORE_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return {"ok": False, "status": 404, "message": "Không tìm thấy job."}

        if job.get("assignedWorker") != worker_id:
            return {"ok": False, "status": 409, "message": "Job không thuộc worker này."}

        ts = now_ts()
        if success:
            affiliate_link = str(body.get("affiliateLink") or "").strip()
            if not affiliate_link:
                return {"ok": False, "status": 400, "message": "Thiếu affiliateLink cho kết quả thành công."}

            campaign_raw_link = str(body.get("campaignRawAffiliateLink") or "").strip()
            campaign_source = str(body.get("campaignSource") or "").strip()
            campaign_aff_id = str(body.get("campaignAffiliateId") or "").strip()
            campaign_sub_id = str(body.get("campaignSubId") or "").strip()

            raw_landing_url = str(body.get("landingUrl") or "").strip()
            raw_clean_url = str(body.get("cleanLandingUrl") or "").strip()
            canonical_clean = canonicalize_landing_url(raw_clean_url or raw_landing_url)

            src_aff_id, src_sub_id, _ = extract_affiliate_parts(affiliate_link)
            if not src_aff_id and campaign_aff_id:
                src_aff_id = campaign_aff_id
            if not src_sub_id and campaign_sub_id:
                src_sub_id = campaign_sub_id
            worker_aff_id = str((WORKERS.get(worker_id) or {}).get("affiliateId") or "").strip()
            final_aff_id = choose_affiliate_id(worker_aff_id, campaign_aff_id, src_aff_id)
            final_sub_id = choose_yt_sub_id(src_sub_id)
            final_affiliate_link = ""
            if canonical_clean:
                final_affiliate_link = build_strict_affiliate_link(canonical_clean, final_aff_id, final_sub_id)
                if not final_affiliate_link:
                    return {"ok": False, "status": 422, "message": "Không build được affiliate link chuẩn."}

            display_affiliate = ""
            if is_http_url(campaign_raw_link):
                display_affiliate = campaign_raw_link
            elif is_http_url(affiliate_link):
                display_affiliate = affiliate_link
            elif final_affiliate_link:
                display_affiliate = final_affiliate_link

            if not display_affiliate:
                return {"ok": False, "status": 422, "message": "Không có affiliate link hợp lệ để trả kết quả."}

            long_affiliate = ""
            if final_affiliate_link:
                long_affiliate = final_affiliate_link
            else:
                _, _, origin_from_aff = extract_affiliate_parts(affiliate_link)
                if origin_from_aff and is_http_url(affiliate_link):
                    long_affiliate = affiliate_link

            job["status"] = "success"
            job["message"] = "Tạo link thành công."
            job["affiliateLink"] = display_affiliate
            job["longAffiliateLink"] = long_affiliate
            job["campaignRawAffiliateLink"] = campaign_raw_link
            job["campaignSource"] = campaign_source
            job["campaignAffiliateId"] = campaign_aff_id or src_aff_id or worker_aff_id
            job["campaignSubId"] = campaign_sub_id or src_sub_id
            job["landingUrl"] = raw_landing_url
            job["cleanLandingUrl"] = canonical_clean or raw_clean_url or raw_landing_url
            job["updatedAt"] = ts
        else:
            job["status"] = "error"
            job["message"] = str(body.get("message") or "Worker không tạo được link.")
            job["updatedAt"] = ts

    return {"ok": True, "status": 200, "message": "Đã cập nhật kết quả job."}


def workers_summary():
    ts = now_ts()
    with STORE_LOCK:
        total = len(WORKERS)
        online = sum(1 for w in WORKERS.values() if ts - w["lastSeen"] <= WORKER_STALE_SEC)

    return {"total": total, "online": online}


def queue_size() -> int:
    with STORE_LOCK:
        return len(PENDING_QUEUE)


def json_response(handler: BaseHTTPRequestHandler, status: int, payload: dict):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type, X-Worker-Token")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def redirect_response(handler: BaseHTTPRequestHandler, location: str, status: int = 302):
    body = f"Redirecting to {location}".encode("utf-8")
    handler.send_response(status)
    handler.send_header("Location", location)
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Type", "text/plain; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


class Handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        json_response(self, 204, {})

    def do_GET(self):
        cleanup_state()
        parsed_path = urlparse(self.path)
        path = parsed_path.path
        query = query_dict(parsed_path.query)

        if path.startswith("/r/"):
            code = path.split("/r/", 1)[1].strip()
            target = get_short_target(code)
            if not target:
                json_response(self, 404, {"success": False, "message": "Short code không tồn tại hoặc đã hết hạn."})
                return
            redirect_response(self, target, 302)
            return

        if path == "/" and query.get("url"):
            record_convert_request("sync")
            if FORCE_YT_MODE:
                mode = "yt"
            else:
                yt_raw = str(query.get("yt", "1")).strip().lower()
                mode = "default" if yt_raw in ("0", "false", "no", "off") else "yt"
            parsed_input = normalize_input(query.get("url", ""))
            if not parsed_input["ok"]:
                json_response(self, 400, {"success": False, "message": parsed_input["error"], "mode": mode})
                return

            job = create_job(str(query.get("url", "")), parsed_input["url"])
            done = wait_for_job_terminal(job["id"], SYNC_WAIT_TIMEOUT_SEC)
            if not done["ok"]:
                json_response(
                    self,
                    422,
                    {"success": False, "message": done["message"], "mode": mode, "jobId": job["id"]},
                )
                return

            final_job = done["job"]
            display_affiliate = str(final_job.get("affiliateLink") or "").strip()
            long_affiliate = str(final_job.get("longAffiliateLink") or "").strip()
            if not long_affiliate:
                long_affiliate = display_affiliate

            long_aff_id, long_sub_id = parse_affiliate_meta(long_affiliate)
            campaign_aff_id = str(final_job.get("campaignAffiliateId") or "").strip()
            campaign_sub_id = str(final_job.get("campaignSubId") or "").strip()

            affiliate_id, sub_id = parse_affiliate_meta(display_affiliate)
            if not affiliate_id:
                affiliate_id = campaign_aff_id or long_aff_id
            if not sub_id:
                sub_id = campaign_sub_id or long_sub_id

            if mode == "yt":
                sub_id = choose_yt_sub_id(sub_id)

            if not display_affiliate:
                display_affiliate = long_affiliate

            short_link = ""
            code = ""
            if is_http_url(long_affiliate):
                short_link, code = make_short_link(self, long_affiliate)

            json_response(
                self,
                200,
                {
                    "success": True,
                    # Keep yt-like output: affiliateLink can be campaign shortlink (e.g., shp.today).
                    "affiliateLink": display_affiliate,
                    # Provide canonical long form for debugging/fallback.
                    "longAffiliateLink": long_affiliate,
                    # Provide optional short link for convenience.
                    "shortAffiliateLink": short_link,
                    "mode": mode,
                    "affiliate_id": affiliate_id,
                    "sub_id": sub_id,
                    "jobId": final_job.get("id"),
                    "shortCode": code,
                },
            )
            return

        if path == "/api/health":
            summary = workers_summary()
            json_response(
                self,
                200,
                {
                    "ok": True,
                    "workers": summary,
                    "queueSize": queue_size(),
                    "timestamp": now_ts(),
                },
            )
            return

        if path == "/api/stats":
            if not is_stats_authorized(self, query):
                json_response(self, 403, {"ok": False, "message": "Forbidden"})
                return
            stats = request_stats_today()
            json_response(
                self,
                200,
                {
                    "ok": True,
                    "date": stats["date"],
                    "today": stats["today"],
                    "totalSinceStart": stats["totalSinceStart"],
                    "timestamp": now_ts(),
                },
            )
            return

        if path.startswith("/api/jobs/"):
            job_id = path.split("/api/jobs/", 1)[1].strip()
            with STORE_LOCK:
                job = JOBS.get(job_id)
                if not job:
                    json_response(self, 404, {"ok": False, "message": "Không tìm thấy job."})
                    return
                data = public_job_view(job)

            json_response(self, 200, {"ok": True, "job": data})
            return

        if path == "/":
            json_response(
                self,
                200,
                {
                    "ok": True,
                    "message": "Queue backend is running.",
                    "hint": "Use GET /?url=<encoded_shopee_link>&yt=1 or POST /api/convert",
                },
            )
            return

        json_response(self, 404, {"ok": False, "message": "Not found"})

    def do_POST(self):
        cleanup_state()
        path = urlparse(self.path).path

        if path == "/api/convert":
            record_convert_request("async")
            try:
                body = parse_json_body(self)
            except ValueError as e:
                json_response(self, 400, {"ok": False, "message": str(e)})
                return

            raw_input = body.get("url") or body.get("input") or ""
            parsed = normalize_input(raw_input)
            if not parsed["ok"]:
                json_response(self, 400, {"ok": False, "message": parsed["error"]})
                return

            job = create_job(str(raw_input), parsed["url"])
            summary = workers_summary()
            msg = "Đã xếp hàng xử lý."
            if summary["online"] == 0:
                msg = "Đã nhận yêu cầu nhưng chưa có worker online."

            json_response(
                self,
                202,
                {
                    "ok": True,
                    "jobId": job["id"],
                    "status": job["status"],
                    "message": msg,
                },
            )
            return

        if path == "/worker/poll":
            try:
                body = parse_json_body(self)
            except ValueError as e:
                json_response(self, 400, {"ok": False, "message": str(e)})
                return

            if not require_worker_token(self.headers, body):
                json_response(self, 401, {"ok": False, "message": "Worker token không hợp lệ."})
                return

            worker_id = upsert_worker(body)
            job = claim_next_job(worker_id)

            json_response(
                self,
                200,
                {
                    "ok": True,
                    "workerId": worker_id,
                    "job": job,
                    "waitMs": 180,
                },
            )
            return

        if path == "/worker/submit":
            try:
                body = parse_json_body(self)
            except ValueError as e:
                json_response(self, 400, {"ok": False, "message": str(e)})
                return

            if not require_worker_token(self.headers, body):
                json_response(self, 401, {"ok": False, "message": "Worker token không hợp lệ."})
                return

            result = submit_job_result(body)
            json_response(self, result["status"], {"ok": result["ok"], "message": result["message"]})
            return

        json_response(self, 404, {"ok": False, "message": "Not found"})

    def log_message(self, format, *args):
        # Keep server quiet and avoid logging request payloads.
        return


def main():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Queue backend running at http://localhost:{PORT}")
    print(f"Worker token: {WORKER_TOKEN}")
    server.serve_forever()


if __name__ == "__main__":
    main()
