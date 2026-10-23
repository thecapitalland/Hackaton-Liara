/**
 * Agate-Liara — پیکربندی از متغیرهای محیطی
 *
 * منبع تنظیمات: env vars ← (اولویت بالا) سپس فایل `.env` در cwd سرویس
 * و در ریشه پکیج. مقادیر واقعی هرگز لاگ یا commit نمی‌شوند.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

/** ریشه پکیج (پوشه src یا dist) */
const here = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(here, "..");

/** سیاست تأیید عملیات نوشتنی */
export type ApprovalPolicy = "strict" | "balanced" | "auto";
export const APPROVAL_POLICIES: readonly ApprovalPolicy[] = ["strict", "balanced", "auto"];

/**
 * بارگذاری `.env`:
 *  1) از ریشه پکیج (توسعه: src/.. ، بیلد: dist/..)
 *  2) از cwd سرویس (محلی که کلاینت MCP سرویس را اجرا کرده)
 * متغیرهای واقعی محیطی بر env فایل اولویت دارند (override: false).
 */
function loadDotEnv(): void {
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.join(PACKAGE_ROOT, ".env"),
  ];
  for (const file of candidates) {
    if (existsSync(file)) {
      dotenv.config({ path: file, override: false, quiet: true });
    }
  }
}
loadDotEnv();

function str(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === null ? fallback : String(v).trim();
}

function bool(name: string, fallback: boolean): boolean {
  const v = str(name);
  if (!v) return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function int(name: string, fallback: number): number {
  const v = Number.parseInt(str(name), 10);
  return Number.isFinite(v) ? v : fallback;
}

const DEFAULT_API_BASE = "https://api.iran.liara.ir";
const DEFAULT_API_FALLBACK = "https://api.liara.ir";
const DEFAULT_DNS_BASE = "https://dns-service.iran.liara.ir";
const DEFAULT_DNS_FALLBACK = "https://dns-service.liara.ir";

export const config = {
  /** توکن API لیارا */
  get token(): string {
    return str("LIARA_API_TOKEN");
  },
  /** شناسه تیم (اختیاری) — به هر درخواست `?teamID=` اضافه می‌شود */
  get teamId(): string {
    return str("LIARA_TEAM_ID");
  },
  /** بیس اصلی API لیارا */
  get apiBase(): string {
    return str("LIARA_API_BASE", DEFAULT_API_BASE) || DEFAULT_API_BASE;
  },
  /** بیس جایگزین API لیارا (در صورت خطای شبکه امتحان می‌شود) */
  get apiBaseFallback(): string {
    return str("LIARA_API_BASE_FALLBACK", DEFAULT_API_FALLBACK) || DEFAULT_API_FALLBACK;
  },
  /** بیس سرویس DNS لیارا */
  get dnsBase(): string {
    return str("LIARA_DNS_BASE", DEFAULT_DNS_BASE) || DEFAULT_DNS_BASE;
  },
  /** بیس جایگزین DNS */
  get dnsBaseFallback(): string {
    return str("LIARA_DNS_BASE_FALLBACK", DEFAULT_DNS_FALLBACK) || DEFAULT_DNS_FALLBACK;
  },
  /** اپ‌هایی که ابزارهای نوشتن اجازهٔ تغییرشان را دارند */
  get allowedApps(): string[] {
    const raw = str("AGATE_ALLOWED_APPS", "agate-liara");
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  },
  /** مسیر فایل‌های state (لاگ ممیزی، تأییدها، baseline) */
  get stateDir(): string {
    return path.join(process.cwd(), ".agate");
  },
  /** مهلت پیش‌فرض درخواست (میلی‌ثانیه) */
  get requestTimeoutMs(): number {
    return int("LIARA_TIMEOUT_MS", 20_000);
  },
  /** سقف حجم آرشیو سورس (۲۵۶ MiB طبق مستندات لیارا) */
  get maxArchiveBytes(): number {
    return int("LIARA_MAX_ARCHIVE_BYTES", 256 * 1024 * 1024);
  },
  /** آیا LLM خارجی پیکربندی شده است؟ */
  get llmEnabled(): boolean {
    return Boolean(str("LLM_BASE_URL") && str("LLM_API_KEY") && str("LLM_MODEL"));
  },
  /**
   * حلقهٔ بررسی diagnose.
   * مقدار صریح agentic|fixed برنده است. در غیر این صورت اگر LLM تنظیم باشد agentic، وگرنه fixed.
   */
  get investigateMode(): "agentic" | "fixed" {
    const raw = str("INVESTIGATE_MODE").toLowerCase();
    if (raw === "agentic" || raw === "fixed") return raw;
    return config.llmEnabled ? "agentic" : "fixed";
  },
  get llmBaseUrl(): string {
    return str("LLM_BASE_URL");
  },
  get llmApiKey(): string {
    return str("LLM_API_KEY");
  },
  get llmModel(): string {
    return str("LLM_MODEL");
  },
  get llmModelFallback(): string {
    return str("LLM_MODEL_FALLBACK");
  },
  get llmDecisionModel(): string {
    return str("LLM_DECISION_MODEL");
  },
  /** مهلت پیش‌فرض هر فراخوانی مدل در حلقهٔ بررسی. */
  get llmTimeoutHintMs(): number {
    return int("LLM_TIMEOUT_MS", 20_000);
  },
  /**
   * سیاست تأیید: strict (پیش‌فرض) | balanced | auto.
   * مقدار ناشناخته امن‌ترین حالت (strict) را فعال می‌کند.
   */
  get approvalPolicy(): ApprovalPolicy {
    const raw = str("APPROVAL_POLICY", "strict").toLowerCase();
    return (APPROVAL_POLICIES as readonly string[]).includes(raw)
      ? (raw as ApprovalPolicy)
      : "strict";
  },
  /** اپ پیش‌فرض پایش مداوم (اگر خالی باشد، اولین اپ allowlist) */
  get watchApp(): string {
    return str("WATCH_APP", config.allowedApps[0] ?? "");
  },
  /** فاصلهٔ چرخه‌های پایش؛ حداقل ۱۰ ثانیه برای جلوگیری از فشار روی سرویس */
  get watchIntervalSec(): number {
    return Math.min(3600, Math.max(10, int("WATCH_INTERVAL_SEC", 60)));
  },
  /** مدت cooldown پس از هر رخداد؛ صفر یعنی غیرفعال */
  get watchCooldownSec(): number {
    return Math.min(24 * 3600, Math.max(0, int("WATCH_COOLDOWN_SEC", 300)));
  },
  /** آیا watch اجازهٔ اقدام درمانی سیاست‌محور دارد؟ */
  get watchRemediate(): boolean {
    return bool("WATCH_REMEDIATE", true);
  },
  /** آیا لاگ با جزئیات بیشتری نوشته شود؟ */
  get verbose(): boolean {
    return bool("AGATE_VERBOSE", false);
  },
};

/** آیا توکن تنظیم شده است؟ */
export function hasToken(): boolean {
  return config.token.length > 0;
}

/** آیا اپ در لیست مجاز است؟ */
export function isAllowedApp(app: string): boolean {
  return config.allowedApps.includes(app);
}
