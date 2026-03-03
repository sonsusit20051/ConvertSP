#!/usr/bin/env python3
import json
import os
import re
import socket
import ssl
import sys
import time
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, quote, urlparse, urlunparse
from urllib.request import Request, urlopen

SERVER_BASE = os.getenv("SERVER_BASE", "http://localhost:8787").rstrip("/")
WORKER_TOKEN = os.getenv("WORKER_TOKEN", "dev-worker-token")
WORKER_ID = os.getenv("WORKER_ID", f"local-{uuid.uuid4().hex[:8]}")
WORKER_NAME = os.getenv("WORKER_NAME", socket.gethostname())
AFFILIATE_ID = os.getenv("AFFILIATE_ID", "17391540096")
SUB_ID = os.getenv("SUB_ID", "YT3")
BASE_REDIRECT = os.getenv("BASE_REDIRECT", "https://s.shopee.vn/an_redir")
RESOLVE_TIMEOUT_SEC = float(os.getenv("RESOLVE_TIMEOUT_SEC", "10"))
DEFAULT_WAIT_SEC = float(os.getenv("DEFAULT_WAIT_SEC", "0.20"))
ALLOW_INSECURE_TLS_RETRY = os.getenv("ALLOW_INSECURE_TLS_RETRY", "1") == "1"

def is_shortlink_host(hostname: str) -> bool:
    host = (hostname or "").lower()
    return host in ("shope.ee", "shp.ee") or host.endswith(".shp.ee") or host.startswith("s.shopee.")


def is_shopee_landing_host(hostname: str) -> bool:
    host = (hostname or "").lower()
    return bool(re.match(r"^([a-z0-9-]+\.)*shopee\.[a-z.]{2,}$", host, re.IGNORECASE))


def has_gads_sig(parsed_url) -> bool:
    pairs = parse_qsl(parsed_url.query, keep_blank_values=True)
    return any(k.lower() == "gads_t_sig" and v for (k, v) in pairs)


def extract_product_ids(path: str):
    full_path = str(path or "")

    # Pattern from product slug style: /something-i.<shop_id>.<item_id>
    slug_match = re.search(r"-i\.(\d+)\.(\d+)(?:/)?$", full_path)
    if slug_match:
        return slug_match.group(1), slug_match.group(2)

    parts = [p for p in full_path.split("/") if p]
    if len(parts) >= 2 and parts[-1].isdigit() and parts[-2].isdigit():
        return parts[-2], parts[-1]

    return None, None


def resolve_landing_url(input_url: str):
    parsed = urlparse(input_url)
    if not is_shortlink_host(parsed.hostname or ""):
        return parsed

    req = Request(
        urlunparse(parsed),
        method="GET",
        headers={
            "User-Agent": "Shopee-Queue-Worker/1.0",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
    )

    try:
        with urlopen(req, timeout=RESOLVE_TIMEOUT_SEC) as resp:
            final_url = resp.geturl()
    except URLError as e:
        if (
            ALLOW_INSECURE_TLS_RETRY
            and "CERTIFICATE_VERIFY_FAILED" in str(e)
            and str(parsed.scheme).lower() == "https"
        ):
            insecure_ctx = ssl._create_unverified_context()
            with urlopen(req, timeout=RESOLVE_TIMEOUT_SEC, context=insecure_ctx) as resp:
                final_url = resp.geturl()
        else:
            raise

    final_parsed = urlparse(final_url)
    if not is_shopee_landing_host(final_parsed.hostname or ""):
        raise ValueError("Shortlink không trỏ về domain Shopee hợp lệ.")

    return final_parsed._replace(fragment="")


def clean_landing_url(parsed_url):
    if not is_shopee_landing_host(parsed_url.hostname or ""):
        raise ValueError("Landing URL không thuộc domain Shopee hợp lệ.")

    shop_id, item_id = extract_product_ids(parsed_url.path)
    if not shop_id or not item_id:
        raise ValueError("Không nhận diện được shop_id/item_id từ landing URL.")

    gads_sig = ""
    for k, v in parse_qsl(parsed_url.query, keep_blank_values=True):
        if k.lower() == "gads_t_sig" and v:
            gads_sig = v
            break

    if not gads_sig:
        raise ValueError("Landing URL không có gads_t_sig. Không thể tạo link chuẩn.")

    canonical = parsed_url._replace(
        scheme="https",
        path=f"/product/{shop_id}/{item_id}",
        query=f"gads_t_sig={quote(gads_sig, safe='')}",
        fragment="",
    )
    return urlunparse(canonical)


def build_affiliate_link(clean_url: str) -> str:
    origin = quote(clean_url, safe="")
    return (
        f"{BASE_REDIRECT}?affiliate_id={quote(AFFILIATE_ID, safe='')}&sub_id={quote(SUB_ID, safe='')}&origin_link={origin}"
    )


def convert_url(input_url: str):
    parsed = resolve_landing_url(input_url)
    clean_url = clean_landing_url(parsed)
    affiliate_link = build_affiliate_link(clean_url)

    return {
        "affiliateLink": affiliate_link,
        "landingUrl": urlunparse(parsed),
        "cleanLandingUrl": clean_url,
    }


def post_json(path: str, payload: dict):
    url = f"{SERVER_BASE}{path}"
    body = json.dumps(payload).encode("utf-8")
    req = Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Worker-Token": WORKER_TOKEN,
        },
    )

    with urlopen(req, timeout=20) as resp:
        raw = resp.read().decode("utf-8")
        return json.loads(raw or "{}")


def main():
    global WORKER_ID

    print(f"Worker started: {WORKER_ID}")
    print(f"Server: {SERVER_BASE}")

    while True:
        try:
            poll_payload = {
                "workerId": WORKER_ID,
                "workerName": WORKER_NAME,
                "affiliateId": AFFILIATE_ID,
                "subId": SUB_ID,
            }
            polled = post_json("/worker/poll", poll_payload)
            WORKER_ID = polled.get("workerId") or WORKER_ID

            job = polled.get("job")
            if not job:
                wait_ms = float(polled.get("waitMs") or int(DEFAULT_WAIT_SEC * 1000))
                time.sleep(max(wait_ms / 1000.0, 0.18))
                continue

            job_id = str(job.get("id") or "")
            input_url = str(job.get("url") or "")

            if not job_id or not input_url:
                post_json(
                    "/worker/submit",
                    {
                        "workerId": WORKER_ID,
                        "jobId": job_id,
                        "success": False,
                        "message": "Job payload không hợp lệ.",
                    },
                )
                continue

            try:
                result = convert_url(input_url)
                post_json(
                    "/worker/submit",
                    {
                        "workerId": WORKER_ID,
                        "jobId": job_id,
                        "success": True,
                        **result,
                    },
                )
                print(f"[{job_id}] success")
            except Exception as convert_error:
                post_json(
                    "/worker/submit",
                    {
                        "workerId": WORKER_ID,
                        "jobId": job_id,
                        "success": False,
                        "message": str(convert_error),
                    },
                )
                print(f"[{job_id}] error: {convert_error}")

        except HTTPError as e:
            print(f"worker http error: {e.code}")
            time.sleep(2)
        except URLError as e:
            print(f"worker network error: {e.reason}")
            time.sleep(2)
        except KeyboardInterrupt:
            print("worker stopped")
            break
        except Exception as e:
            print(f"worker unexpected error: {e}")
            time.sleep(2)


if __name__ == "__main__":
    if not AFFILIATE_ID:
        print("Missing AFFILIATE_ID")
        sys.exit(1)
    main()
