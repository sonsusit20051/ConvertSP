# Shopee Aff Converter System (User không cần cài extension)

## Mô hình hoạt động
- User vào web, dán 1 link Shopee, bấm convert.
- Frontend gửi request tạo job tới backend FastAPI.
- Extension trên máy bạn (đã login Shopee Affiliate) chạy ngầm như worker.
- Worker lấy job từ backend, gọi API nội bộ để convert, trả kết quả về backend.
- Frontend polling trạng thái job và hiển thị link aff.

## Thành phần
- `index.html`: shell HTML của frontend.
- `assets/*`: frontend module theo chức năng.
- `backend/server.py`: backend FastAPI + SQLite queue.
- `extension/*`: worker extension MV3.

## Cấu trúc frontend
- `assets/css/styles.css`: toàn bộ giao diện.
- `assets/js/config.js`: biến cấu hình frontend (`BACKEND_BASE_URL`, timeout, polling).
- `assets/js/dom.js`: gom phần tử DOM.
- `assets/js/state.js`: state runtime của UI.
- `assets/js/ui.js`: render trạng thái UI.
- `assets/js/validators.js`: validate chặt 1 link Shopee/lần.
- `assets/js/clipboard.js`: đọc/ghi clipboard.
- `assets/js/api.js`: gọi API backend + parse lỗi.
- `assets/js/actions.js`: xử lý event nghiệp vụ.
- `assets/js/bootstrap.js`: bind event và khởi tạo app.

## Cấu trúc extension
- `extension/background.js`: entrypoint service worker.
- `extension/config.js`: cấu hình worker/API/key/keepalive.
- `extension/internal-api.js`: gọi API nội bộ convert.
- `extension/backend-api.js`: gọi API worker của backend.
- `extension/worker-runner.js`: xử lý vòng đời job.
- `extension/keepalive.js`: offscreen keep-alive + alarm fallback.
- `extension/offscreen.html` + `extension/offscreen.js`: ping định kỳ đánh thức worker.
- `extension/popup.html` + `extension/popup.js` + `extension/popup.css`: popup trạng thái + nút `Kiểm tra ngay`.
- `extension/popup-bridge.js`: bridge giữa popup và background worker.
- Request convert qua tab affiliate được thực thi bằng `chrome.scripting.executeScript(..., world: "MAIN")` để chạy first-party context ổn định hơn.

## 1) Chạy backend FastAPI
### Cài dependencies
```bash
pip install fastapi uvicorn
```

### Run local
```bash
cd /Users/sonmoi/Downloads/shopee\ convert
WORKER_KEY='your-strong-worker-key' \
ALLOWED_ORIGINS='http://localhost:5173,http://127.0.0.1:5173' \
python3 backend/server.py
```

Backend mặc định chạy ở `http://127.0.0.1:8787`.

## 2) Biến môi trường backend quan trọng
- `WORKER_KEY`: bắt buộc, phải trùng với extension.
- `ALLOWED_ORIGINS`: danh sách origin frontend được phép gọi API. Không dùng `*`.
- `MAX_PENDING_JOBS` (default `2000`)
- `USER_RATE_LIMIT_WINDOW_SEC` (default `10`)
- `USER_RATE_LIMIT_MAX` (default `6`)
- `MAX_URL_LENGTH` (default `2048`)
- `JOB_RETENTION_HOURS` (default `24`)
- `JOB_CLEANUP_INTERVAL_SEC` (default `300`)
- `RATE_LIMIT_CLEANUP_INTERVAL_SEC` (default `60`)

## 3) Cấu hình extension
### Sửa `extension/config.js`
- `INTERNAL_API_AUTH_MODE`:
  - `cookie`: test theo session Shopee Aff đang login trên trình duyệt.
  - `bearer`: dùng token Authorization.
- `INTERNAL_API_URL`
- `INTERNAL_API_TOKEN`
- `INTERNAL_API_METHOD`
- `INTERNAL_API_URL_FIELD`
- `INTERNAL_API_EXTRA_BODY` (nếu API cần thêm field cố định)
- `INTERNAL_API_RESULT_FIELDS`
- `INTERNAL_API_WITH_CREDENTIALS`
- `INTERNAL_API_CSRF_COOKIE_NAME` + `INTERNAL_API_CSRF_HEADER_NAME` (nếu API cần CSRF header)
- `BACKEND_BASE_URL`
- `WORKER_KEY` (giống backend)

### Sửa `extension/manifest.json`
- `host_permissions` đúng domain API nội bộ + backend public.
- Nếu test cookie Shopee Aff, giữ `host_permissions` có `https://*.shopee.vn/*` và `https://affiliate.shopee.vn/*`.

### Cài extension
1. Mở `chrome://extensions`
2. Bật `Developer mode`
3. `Load unpacked`
4. Chọn thư mục `extension/`
5. Reload extension sau mỗi lần sửa code.
6. Bấm icon extension để mở popup trạng thái và nút `Kiểm tra ngay`.

## 4) Cấu hình frontend
- Sửa `assets/js/config.js`:
  - `BACKEND_BASE_URL` = backend public URL.
- Deploy `index.html` + `assets/*` lên domain web của bạn.

## API contract backend
### User API
- `POST /api/jobs`
```json
{ "url": "https://shopee.vn/..." }
```
- `GET /api/jobs/{jobId}`

Trạng thái job: `pending`, `processing`, `done`, `failed`

### Worker API (cần header `X-Worker-Key`)
- `GET /api/worker/jobs/next`
- `POST /api/worker/jobs/{jobId}/complete`
```json
{ "affLink": "https://s.shopee.vn/..." }
```
- `POST /api/worker/jobs/{jobId}/fail`
```json
{ "error": "Lý do lỗi" }
```

## Lưu ý production
- Hệ thống chỉ nhận đúng 1 link Shopee/lần (không hỗ trợ bulk).
- Extension dùng offscreen keep-alive ping + alarm 1 phút để giảm nguy cơ worker ngủ.
- Máy bạn cần online + Chrome mở để worker xử lý liên tục.
- Nên rotate `INTERNAL_API_TOKEN` định kỳ và thêm monitor/log.
- Nên backup `backend/jobs.db` theo lịch.

## Test nhanh bằng session Shopee Aff (không dùng token)
1. Mở `extension/config.js`:
- `INTERNAL_API_AUTH_MODE: "cookie"`
- `INTERNAL_API_COOKIE_SOURCE: "affiliate_tab"`
- `INTERNAL_API_URL: "https://affiliate.shopee.vn/api/v3/gql?q=batchCustomLink"`
- `INTERNAL_API_WITH_CREDENTIALS: true`
- `INTERNAL_API_CSRF_COOKIE_NAME: "csrftoken"`
- `INTERNAL_API_CSRF_HEADER_NAME: "csrf-token"`

2. Nếu request gốc có CSRF header:
- Điền `INTERNAL_API_CSRF_COOKIE_NAME` (vd: `csrftoken`)
- Điền `INTERNAL_API_CSRF_HEADER_NAME` (vd: `x-csrftoken`)

3. Reload extension tại `chrome://extensions`.
4. Bấm popup extension:
- kiểm tra `Auth mode: COOKIE`
- bấm `Kiểm tra ngay`.

5. Nếu vẫn lỗi:
- Mở DevTools của service worker extension (`chrome://extensions` -> Inspect views).
- Xem lỗi trả về:
  - `Shopee trả failCode != 0` -> request tới Shopee bị từ chối, cần bổ sung header/params anti-abuse.
  - `GraphQL trả lỗi` -> endpoint hoặc payload chưa đúng phiên hiện tại.
  - `Failed to fetch` -> backend/offline hoặc network chặn.

6. Với mã lỗi anti-abuse (ví dụ `90309999`):
- Mở tab `https://affiliate.shopee.vn/offer/custom_link`.
- Tạo 1 link thủ công ngay trên trang đó (để extension bắt header động).
- Mở popup extension, kiểm tra `Captured headers` > 0.
- Quay lại web và bấm convert lại.

## Thông tin bạn cần cung cấp để mình cấu hình production hoàn chỉnh
1. Domain frontend public.
2. Domain backend public.
3. `INTERNAL_API_URL` + kiểu auth + token + mẫu response success/error.
4. `WORKER_KEY` production.
5. Ngưỡng tải dự kiến (request/phút, queue max, rate limit).
6. Hạ tầng deploy backend (VPS/platform + reverse proxy + SSL).
