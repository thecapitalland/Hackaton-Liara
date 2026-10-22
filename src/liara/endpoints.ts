/**
 * Agate-Liara — تمام مسیرهای API لیارا در یک جا.
 *
 * منبع حقیقت اولیه: مستندات رسمی لیارا (openapi.liara.ir) و کد رسمی liara-cli.
 * اگر preflight زنده مسیر/فیلد متفاوتی نشان دهد، همین‌جا و در docs/LIARA_API.md
 * اصلاح می‌شود — هرگز endpoint از خودمان اختراع نمی‌شود.
 */

const enc = encodeURIComponent;

export const EP = {
  /* ── حساب و پروژه‌ها ─────────────────────────────────────────────── */
  listProjects: "/v1/projects",
  createProject: "/v1/projects",
  getProject: (name: string) => `/v1/projects/${enc(name)}`,
  /** فقط endpoint پلن‌ها: GET /v1/me → plans */
  me: "/v1/me",
  networks: '/v1/networks',

  /* ── دیپلوی ──────────────────────────────────────────────────────── */
  uploadSource: (name: string) => `/v2/projects/${enc(name)}/sources`,
  createRelease: (name: string) => `/v2/projects/${enc(name)}/releases`,
  getRelease: (releaseId: string) => `/v1/releases/${enc(releaseId)}`,
  buildLogs: (releaseId: string) => `/v2/releases/${enc(releaseId)}/build-logs`,
  cancelRelease: (releaseId: string) => `/v2/releases/${enc(releaseId)}/cancel`,
  listReleases: (name: string) => `/v1/projects/${enc(name)}/releases`,

  /* ── مدیریت سرویس ────────────────────────────────────────────────── */
  updateEnvs: "/v1/projects/update-envs",
  updatePort: "/v1/projects/update-port",
  restart: (name: string) => `/v1/projects/${enc(name)}/actions/restart`,
  scale: (name: string) => `/v1/projects/${enc(name)}/actions/scale`,
  resize: (name: string) => `/v1/projects/${enc(name)}/resize`,

  /* ── مشاهده ──────────────────────────────────────────────────────── */
  logsV1: (name: string) => `/v1/projects/${enc(name)}/logs`,
  logsV2: (name: string) => `/v2/projects/${enc(name)}/logs`,
  events: (name: string) => `/v1/projects/${enc(name)}/events`,
  metricsSummary: (name: string) => `/v1/projects/${enc(name)}/metrics/summary`,
  metricsCpu: (name: string) => `/v1/projects/${enc(name)}/metrics/cpu`,
  metricsMemory: (name: string) => `/v1/projects/${enc(name)}/metrics/memory`,
  metricsNetworkReceive: (name: string) => `/v1/projects/${enc(name)}/metrics/network-receive`,
  metricsNetworkTransmit: (name: string) => `/v1/projects/${enc(name)}/metrics/network-transmit`,

  /* ── دامنه ───────────────────────────────────────────────────────── */
  listDomains: "/v1/domains",
  createDomain: "/v1/domains",
  checkDomain: (domainId: string) => `/v1/domains/${enc(domainId)}/check`,
  provisionSslCerts: "/v1/domains/provision-ssl-certs",
} as const;

/** مسیرهای سرویس DNS (بیس جدا: LIARA_DNS_BASE) */
export const DNS_EP = {
  zones: "/api/v1/zones",
  zoneCheck: (zone: string) => `/api/v1/zones/${enc(zone)}/check`,
  zoneRecords: (zone: string) => `/api/v1/zones/${enc(zone)}/dns-records`,
  zoneRecord: (zone: string, recordId: string) =>
    `/api/v1/zones/${enc(zone)}/dns-records/${enc(recordId)}`,
} as const;

/** کدهای خطای نرمال‌شده (برای پاسخ‌های ساخت‌یافته) */
export const ERR = {
  AUTH_REQUIRED: "AUTH_REQUIRED",
  NOT_FOUND: "NOT_FOUND",
  RATE_LIMIT: "API_RATE_LIMIT",
  API_UNAVAILABLE: "API_UNAVAILABLE",
  NETWORK: "NETWORK",
  TIMEOUT: "TIMEOUT",
  BAD_REQUEST: "BAD_REQUEST",
  CONFLICT: "CONFLICT",
  SERVER: "API_UNAVAILABLE",
  UNKNOWN: "UNKNOWN_PROVIDER_RESULT",
} as const;
