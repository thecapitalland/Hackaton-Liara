/**
 * Agate-Liara — موتور تأیید (approval) برای عملیات نوشتنی.
 *
 * دو مسیر:
 *  1) MCP Elicitation (اگر کلاینت قابلیت elicitation را اعلام کرده باشد):
 *     کاربر در IDE گزینه‌ها را می‌بیند و مستقیم تأیید/لغو می‌کند.
 *  2) Fallback: رکورد تأیید در ./.agate/approvals.json ذخیره می‌شود و ابزار
 *     `execute_action(approvalId)` آن را اجرا می‌کند.
 *
 * ویژگی‌های امنیتی: تک‌مصرف، مهلت ۱۰ دقیقه، مقید به هش پارامترهای دقیق.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config, type ApprovalPolicy } from "./config.js";
import { fa } from "./i18n/fa.js";

export type Risk = "low" | "medium" | "high";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "used";

/**
 * اقدام‌هایی که به‌دلیل هزینه یا ریسک عملیاتی، صرف‌نظر از سیاست،
 * همیشه تأیید انسانی می‌خواهند.
 */
export const ALWAYS_APPROVAL_KINDS: readonly string[] = [
  "liara_create_app",
  "liara_create_network",
  "liara_create_disk",
  "liara_resize",
  "liara_scale",
];

export interface ApprovalDecision {
  policy: ApprovalPolicy;
  risk: Risk;
  requiresApproval: boolean;
  automatic: boolean;
  reasonFa: string;
  /** خط دقیق نمایش برای اجرای خودکار؛ فقط وقتی automatic=true */
  autoNoticeFa?: string;
}

/** وضعیت‌هایی که دیگر هرگز تغییر نمی‌کنند (به‌ویژه بازگشت به approved ممنوع است). */
export const TERMINAL_STATUSES = ["rejected", "expired", "used"] as const;

export interface ApprovalChoice {
  value: string;
  labelFa: string;
  descriptionFa?: string;
  recommended?: boolean;
}

export interface ApprovalRequest {
  /** نام ابزار یا kind عملیات */
  tool: string;
  app?: string;
  params: Record<string, unknown>;
  /** خلاصهٔ کوتاه فارسی برای نمایش به کاربر */
  summaryFa: string;
  risk: Risk;
  /** اثر عملیات: ری‌استارت/قطعی/هزینه */
  impact: string;
  /** گزینه‌ها برای elicitation (۳ تا ۴ گزینه، یکی پیشنهادی) */
  choices: ApprovalChoice[];
}

export interface ApprovalRecord {
  approvalId: string;
  tool: string;
  app?: string;
  params: Record<string, unknown>;
  summaryFa: string;
  risk: Risk;
  impact: string;
  choices: ApprovalChoice[];
  hash: string;
  createdAt: string;
  expiresAt: string;
  status: ApprovalStatus;
  chosen?: string;
  usedAt?: string;
  decidedAt?: string;
}

/* ───────────────────────── ابزارهای هش ───────────────────────── */

/** JSON کانونی (کلیدهای مرتب‌شده) برای هش پایدار */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** sha256 هگز-شده از {tool, app, params} */
export function hashParams(tool: string, app: string | undefined, params: Record<string, unknown>): string {
  return createHash("sha256")
    .update(canonicalJson({ tool, app: app ?? null, params }))
    .digest("hex");
}

/* ───────────────────────── سیاست تأیید ───────────────────────── */

/**
 * ریسک مؤثر یک اقدام. عملیات هزینه‌دار/پرخطر همیشه high هستند.
 * rollback_last_env_change خودش risk=medium اعلام می‌کند و به سیاست عادی
 * low/medium/high سپرده می‌شود؛ هیچ استثنای مخفی برای BUG_MODE وجود ندارد.
 */
export function effectiveRisk(
  tool: string,
  _params: Record<string, unknown>,
  declaredRisk: Risk,
): Risk {
  if (ALWAYS_APPROVAL_KINDS.includes(tool)) return "high";
  return declaredRisk;
}

/**
 * تنها نقطهٔ تصمیم‌گیری تأیید در کل سرور.
 * - high: در همهٔ سیاست‌ها تأیید می‌خواهد.
 * - strict: همهٔ نوشتن‌ها تأیید می‌خواهند.
 * - balanced: low خودکار؛ medium/high تأیید.
 * - auto: low/medium خودکار؛ high تأیید.
 */
export function decideApproval(input: {
  tool: string;
  params?: Record<string, unknown>;
  declaredRisk: Risk;
  /** فقط برای تست/شبیه‌سازی؛ پیش‌فرض از config خوانده می‌شود. */
  policy?: ApprovalPolicy;
}): ApprovalDecision {
  const policy = input.policy ?? config.approvalPolicy;
  const risk = effectiveRisk(input.tool, input.params ?? {}, input.declaredRisk);

  if (risk === "high") {
    return {
      policy,
      risk,
      requiresApproval: true,
      automatic: false,
      reasonFa: "اقدام پرخطر یا هزینه‌دار است؛ در همهٔ سیاست‌ها تأیید انسانی لازم است.",
    };
  }

  if (policy === "strict") {
    return {
      policy,
      risk,
      requiresApproval: true,
      automatic: false,
      reasonFa: "سیاست strict: همهٔ اقدام‌های نوشتنی نیازمند تأیید هستند.",
    };
  }

  if (policy === "balanced" && risk !== "low") {
    return {
      policy,
      risk,
      requiresApproval: true,
      automatic: false,
      reasonFa:
        "سیاست balanced: اقدام medium/high یا تغییر env نیازمند تأیید است؛ rollback_last_env_change اکنون medium است و restart کم‌خطر می‌ماند.",
    };
  }

  const reasonFa =
    policy === "balanced"
      ? "اقدام کم‌خطر و برگشت‌پذیر است."
      : "اقدام پرخطر یا هزینه‌دار نیست.";
  return {
    policy,
    risk,
    requiresApproval: false,
    automatic: true,
    reasonFa,
    autoNoticeFa: `🤖 اجرای خودکار طبق سیاست ${policy} — ${reasonFa}`,
  };
}

/* ───────────────────────── ذخیره‌سازی ───────────────────────── */

function approvalsPath(): string {
  const dir = config.stateDir;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return path.join(dir, "approvals.json");
}

function loadStore(): { approvals: Record<string, ApprovalRecord> } {
  const file = approvalsPath();
  if (!existsSync(file)) return { approvals: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { approvals?: Record<string, ApprovalRecord> };
    return { approvals: parsed.approvals ?? {} };
  } catch {
    return { approvals: {} };
  }
}

function saveStore(store: { approvals: Record<string, ApprovalRecord> }): void {
  writeFileSync(approvalsPath(), JSON.stringify(store, null, 2), "utf8");
}

/* ───────────────────────── چرخهٔ تأیید ───────────────────────── */

/** ساخت یک درخواست تأیید معلق (fallback مسیر elicitation) */
export function createPendingApproval(req: ApprovalRequest): ApprovalRecord {
  const now = new Date();
  const expires = new Date(now.getTime() + 10 * 60 * 1000);
  const record: ApprovalRecord = {
    approvalId: randomUUID(),
    tool: req.tool,
    app: req.app,
    params: req.params,
    summaryFa: req.summaryFa,
    risk: req.risk,
    impact: req.impact,
    choices: req.choices,
    hash: hashParams(req.tool, req.app, req.params),
    createdAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    status: "pending",
  };
  const store = loadStore();
  store.approvals[record.approvalId] = record;
  saveStore(store);
  return record;
}

export function getApproval(approvalId: string): ApprovalRecord | undefined {
  return loadStore().approvals[approvalId];
}

export function listApprovals(): ApprovalRecord[] {
  const store = loadStore();
  return Object.values(store.approvals).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function setApprovalStatus(approvalId: string, status: ApprovalStatus, chosen?: string): void {
  const store = loadStore();
  const rec = store.approvals[approvalId];
  if (!rec) return;

  // وضعیت‌های پایانی قفل‌اند: هرگز به pending/approved برنمی‌گردند.
  if ((TERMINAL_STATUSES as readonly ApprovalStatus[]).includes(rec.status) && status !== rec.status) {
    return;
  }

  // تأیید پس از پایان مهلت = منقضی، نه تأیید. هیچ تمدید خودکاری وجود ندارد.
  if (status === "approved" && isApprovalExpired(rec)) {
    rec.status = "expired";
    rec.decidedAt = new Date().toISOString();
    saveStore(store);
    return;
  }

  rec.status = status;
  if (chosen) rec.chosen = chosen;
  rec.decidedAt = new Date().toISOString();
  saveStore(store);
}

/** آیا مهلت این رکورد (بر اساس زمان فعلی یا زمان داده‌شده) گذشته است؟ */
export function isApprovalExpired(rec: ApprovalRecord, now = Date.now()): boolean {
  const expiresAt = Date.parse(rec.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}

/** بررسی اعتبار یک رکورد تأیید: منقضی/استفاده‌شده/هش ناهماهنگ */
export function validateApproval(
  rec: ApprovalRecord,
): { ok: true } | { ok: false; reason: string } {
  if (rec.status === "used") return { ok: false, reason: "این درخواست قبلاً اجرا شده است (تک‌مصرف)." };
  if (rec.status === "rejected") return { ok: false, reason: "این درخواست لغو شده است." };
  if (rec.status === "expired") {
    return { ok: false, reason: "مهلت این درخواست تمام شده است؛ درخواست تأیید تازه لازم است و تمدید خودکار انجام نمی‌شود." };
  }
  if (rec.status !== "pending" && rec.status !== "approved") {
    return { ok: false, reason: "وضعیت درخواست تأیید نامعتبر است." };
  }
  if (isApprovalExpired(rec)) {
    // ثبت انقضا؛ رکورد مرده است و هرگز دوباره approved نمی‌شود.
    setApprovalStatus(rec.approvalId, "expired");
    return { ok: false, reason: "مهلت این درخواست (۱۰ دقیقه) تمام شده است؛ درخواست تأیید تازه لازم است و تمدید خودکار انجام نمی‌شود." };
  }
  const expected = hashParams(rec.tool, rec.app, rec.params);
  if (expected !== rec.hash) {
    return { ok: false, reason: "پارامترهای درخواست با مقدار تأییدشده یکسان نیستند." };
  }
  return { ok: true };
}

/** مصرف (تک‌مصرف) یک درخواست تأیید */
export function consumeApproval(approvalId: string): { ok: true; record: ApprovalRecord } | { ok: false; reason: string } {
  const rec = getApproval(approvalId);
  if (!rec) return { ok: false, reason: "درخواست تأیید پیدا نشد." };
  const check = validateApproval(rec);
  if (!check.ok) return check;
  if (rec.status !== 'approved') return { ok: false, reason: 'ابتدا کاربر باید درخواست را با npm run approve -- <approvalId> تأیید کند.' };
  const store = loadStore();
  store.approvals[approvalId] = { ...rec, status: "used", usedAt: new Date().toISOString() };
  saveStore(store);
  return { ok: true, record: rec };
}

/* ───────────────────────── Elicitation ───────────────────────── */

/** تابعی که سرور MCP برای elicitation ثبت می‌کند (در صورت پشتیبانی کلاینت) */
export interface ElicitationDecision {
  approved: boolean;
  choice?: string;
  reason?: string;
}

/**
 * تفسیر پاسخ elicitation. Fail-closed است:
 * گزینهٔ غایب یا ناشناخته هرگز با choices[0] جایگزین نمی‌شود.
 * `cancel` حتی اگر در فهرست باشد اجرا نیست.
 */
export function resolveElicitationResponse(
  action: string,
  choice: unknown,
  allowed: readonly string[],
): ElicitationDecision {
  if (action === "decline") {
    return { approved: false, reason: "کاربر درخواست را رد کرد." };
  }
  if (action !== "accept") {
    return {
      approved: false,
      reason:
        action === "cancel"
          ? "کاربر عملیات را لغو کرد."
          : "کاربر پنجرهٔ تأیید را بست (لغو).",
    };
  }
  const valid =
    typeof choice === "string" &&
    choice.length > 0 &&
    choice !== "cancel" &&
    allowed.includes(choice);
  if (!valid) {
    return { approved: false, reason: "invalid_elicitation_response" };
  }
  return { approved: true, choice };
}

export type Elicitor = (
  summaryFa: string,
  choices: ApprovalChoice[],
  impact: string,
) => Promise<ElicitationDecision>;

let elicitor: Elicitor | null = null;

export function setElicitor(fn: Elicitor | null): void {
  elicitor = fn;
}

export type ApprovalOutcome =
  | { mode: "approved"; choice: string; record?: ApprovalRecord }
  | { mode: "rejected"; reason: string }
  | { mode: "pending"; record: ApprovalRecord };

/**
 * یک انتخاب ساده از کاربر (مثل انتخاب پلن) — بدون ثبت رکورد تأیید.
 * اگر elicitation در دسترس نباشد `null` برمی‌گردد.
 */
export async function askChoice(
  summaryFa: string,
  choices: ApprovalChoice[],
  impact: string,
): Promise<string | null> {
  if (!elicitor) return null;
  try {
    const res = await elicitor(summaryFa, choices, impact);
    if (res.approved && res.choice) return res.choice;
    return null;
  } catch {
    return null;
  }
}

/**
 * گرفتن تأیید برای یک عملیات نوشتنی.
 * اگر elicitation در دسترس نباشد → رکورد معلق ساخته می‌شود و ابزار باید
 * شناسهٔ approvalId را به کاربر برگرداند.
 */
export async function requireApproval(req: ApprovalRequest): Promise<ApprovalOutcome> {
  if (elicitor) {
    try {
      const res = await elicitor(req.summaryFa, req.choices, req.impact);
      if (res.approved && res.choice && res.choice !== 'cancel' && req.choices.some(c => c.value === res.choice)) {
        return { mode: "approved", choice: res.choice };
      }
      return { mode: "rejected", reason: res.reason ?? "کاربر لغو کرد." };
    } catch {
      /* elicitation در دسترس نبود → fallback */
    }
  }
  return { mode: "pending", record: createPendingApproval(req) };
}

/** پیام فارسی برای رکورد معلق */
export function pendingMessage(record: ApprovalRecord): string {
  const lines = [
    `${fa.needApproval}`,
    `📌 ${record.summaryFa}`,
    `⚠️ اثر: ${record.impact}`,
    `🔑 شناسهٔ تأیید: ${record.approvalId}`,
    `⏱️ مهلت: تا ${new Date(record.expiresAt).toLocaleTimeString("fa-IR")} (۱۰ دقیقه)`,
    `▶️ کاربر در ترمینال: npm run approve -- ${record.approvalId}`,
    `▶️ سپس: execute_action(approvalId="${record.approvalId}")`,
  ];
  return lines.join("\n");
}

/** پیام فارسی برای لغو */
export const REJECTED_MESSAGE = fa.rejected;
