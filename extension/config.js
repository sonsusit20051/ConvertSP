(function (self) {
  self.ExtConfig = {
    // --- Internal convert API mode ---
    // "cookie": dùng session/cookie đang login trên trình duyệt.
    // "bearer": dùng token Authorization như cách cũ.
    INTERNAL_API_AUTH_MODE: "cookie",

    // Với mode cookie:
    // - "affiliate_tab": gọi API ngay trong tab affiliate.shopee.vn (ổn định hơn với anti-abuse)
    // - "service_worker": gọi trực tiếp từ service worker
    INTERNAL_API_COOKIE_SOURCE: "affiliate_tab",
    INTERNAL_API_TAB_MATCH_URLS: [
      "https://affiliate.shopee.vn/*"
    ],
    INTERNAL_API_AUTO_OPEN_AFFILIATE_TAB: true,
    INTERNAL_API_TAB_OPEN_URL: "https://affiliate.shopee.vn/offer/custom_link",

    // Endpoint convert từ Shopee Affiliate (GraphQL).
    INTERNAL_API_URL: "https://affiliate.shopee.vn/api/v3/gql?q=batchCustomLink",
    INTERNAL_API_METHOD: "POST",

    // Chỉ dùng khi INTERNAL_API_AUTH_MODE = "bearer"
    INTERNAL_API_TOKEN: "REPLACE_WITH_YOUR_TOKEN",

    // Dùng cho mode cookie/session
    INTERNAL_API_WITH_CREDENTIALS: true,
    INTERNAL_API_REFERRER: "https://affiliate.shopee.vn/offer/custom_link",
    INTERNAL_API_REFERRER_POLICY: "strict-origin-when-cross-origin",
    INTERNAL_API_CSRF_COOKIE_NAME: "csrftoken",
    INTERNAL_API_CSRF_HEADER_NAME: "csrf-token",

    // Header bổ sung cố định.
    INTERNAL_API_EXTRA_HEADERS: {
      "x-sz-sdk-version": "1.12.21"
    },

    // Tự bắt header anti-abuse từ request thật trên tab Shopee Affiliate.
    INTERNAL_API_USE_CAPTURED_HEADERS: true,
    INTERNAL_API_CAPTURE_HEADER_NAMES: [
      "csrf-token",
      "x-sap-ri",
      "x-sap-sec",
      "af-ac-enc-dat",
      "af-ac-enc-sz-token",
      "x-sz-sdk-version"
    ],

    // Body template: mọi chuỗi "__URL__" sẽ được thay bằng link cần convert.
    INTERNAL_API_BODY_TEMPLATE: {
      operationName: "batchGetCustomLink",
      query: "\n    query batchGetCustomLink($linkParams: [CustomLinkParam!], $sourceCaller: SourceCaller){\n      batchCustomLink(linkParams: $linkParams, sourceCaller: $sourceCaller){\n        shortLink\n        longLink\n        failCode\n      }\n    }\n    ",
      variables: {
        linkParams: [
          {
            originalLink: "__URL__",
            advancedLinkParams: {}
          }
        ],
        sourceCaller: "CUSTOM_LINK_CALLER"
      }
    },

    // Fallback nếu không dùng template.
    INTERNAL_API_URL_FIELD: "url",
    INTERNAL_API_EXTRA_BODY: {},
    INTERNAL_API_RESULT_FIELDS: [
      "data.batchCustomLink[0].shortLink",
      "data.batchCustomLink[0].longLink",
      "data.batchCustomLink[0].short_link",
      "data.batchCustomLink[0].long_link",
      "data.shortLink",
      "data.longLink",
      "data.short_link",
      "data.long_link"
    ],
    INTERNAL_API_FAIL_CODE_FIELD: "data.batchCustomLink[0].failCode",
    INTERNAL_API_SUCCESS_FAIL_CODE: 0,

    BACKEND_BASE_URL: "http://127.0.0.1:8787",
    WORKER_KEY: "change-me-worker-key",

    // Chrome alarms in production require >= 1 minute.
    WORKER_ALARM: "poll-job-queue",
    WORKER_ALARM_MINUTES: 1,

    // Throughput tuning: each cycle can process multiple queued jobs.
    WORKER_MAX_BATCH: 15,
    // When queue is empty at cycle start, retry quickly to reduce pickup latency.
    WORKER_IDLE_RETRY_COUNT: 3,
    WORKER_IDLE_RETRY_DELAY_MS: 250,

    // Offscreen keep-alive ping interval (seconds).
    KEEPALIVE_PING_INTERVAL_SEC: 2,
    KEEPALIVE_MESSAGE_TYPE: "KEEPALIVE_TICK"
  };
})(self);
