window.ShopeeConfig = {
  APP_VERSION: "2026.03.04.2",
  BACKEND_BASE_URL: "https://convertsp-api.onrender.com",
  JOB_TIMEOUT_MS: 120000,
  JOB_PENDING_PICKUP_TIMEOUT_MS: 5000,
  JOB_PROCESSING_TIMEOUT_MS: 5000,
  JOB_POLL_MS: 400,
  MIN_CONVERT_INTERVAL_MS: 700,
  SUCCESS_CONVERT_COOLDOWN_MS: 5000,
  API_REQUEST_TIMEOUT_MS: 10000,
  URL_REGEX: /https?:\/\/[^\s\"'<>]+/gi,
  INPUT_CACHE_KEY: "shopee_converter_input_cache",
  ENABLE_INPUT_CACHE: false,

  // Fallback link khi backend/ext không phản hồi kịp.
  FALLBACK_ON_EXTENSION_TIMEOUT: true,
  // Luôn ưu tiên luồng 1 tối thiểu 5s trước khi trả link luồng 2.
  FALLBACK_MIN_WAIT_MS: 5000,
  FALLBACK_REDIRECT_URL: "https://s.shopee.vn/an_redir",
  FALLBACK_AFFILIATE_IDS: [
    "17322940169",
    "17391540096",
    "17397970458"
  ],
  FALLBACK_AFFILIATE_PICK_MODE: "round_robin",
  FALLBACK_DEFAULT_TLD: "vn",
  // 5 slot: giữ slot rỗng để tạo sub_id dạng a-b---e
  FALLBACK_SUB_SLOTS: ["cvweb", "sonmoi", "", "", ""],
  // sanitize: đổi "-" thành "_" | strict: báo lỗi
  FALLBACK_SUB_HYPHEN_POLICY: "sanitize",
  FALLBACK_SUB_KEEP_EMPTY_SLOTS: true,
  // Backward compatibility (nếu không dùng FALLBACK_SUB_SLOTS)
  FALLBACK_SUB_ID: "cvweb-sonmoi---",

  // Fallback riêng cho luồng Youtube khi worker/ext không phản hồi.
  FALLBACK_YT_AFFILIATE_IDS: ["17391540096"],
  FALLBACK_YT_AFFILIATE_PICK_MODE: "fixed",
  FALLBACK_YT_DEFAULT_TLD: "vn",
  FALLBACK_YT_SUB_SLOTS: ["YT3", "", "", "", ""],
  FALLBACK_YT_SUB_HYPHEN_POLICY: "sanitize",
  FALLBACK_YT_SUB_KEEP_EMPTY_SLOTS: false,
  FALLBACK_YT_SUB_ID: "YT3",
  FALLBACK_YT_INCLUDE_GADS_T_SIG: true
};
