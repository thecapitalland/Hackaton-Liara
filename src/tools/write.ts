/**
 * Agate-Liara — ابزارهای Tier B (نیازمند تأیید) و رجیستری عملیات.
 *
 * هر عملیات نوشتنی از یک مسیر واحد عبور می‌کند:
 *   بررسی اپ مجاز → ساخت خلاصهٔ فارسی → تأیید (elicitation یا fallback) → اجرا → ممیزی
 * به این ترتیب «لغو» هیچ درخواست نوشتنی به لیارا نمی‌فرستد.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config, isAllowedApp, readOwnedApps, registerOwnedApp } from "../config.js";
import { fa, maskValue } from "../i18n/fa.js";
import {
  consumeApproval,
  createPendingApproval,
  decideApproval,
  effectiveRisk,
  getApproval,
  isApprovalExpired,
  pendingMessage,
  requireApproval,
  validateApproval,
  type ApprovalChoice,
  type Risk,
} from "../approval.js";
import type { AuditApproval } from "../audit.js";
import { liaraGet, liaraPost, LiaraError } from "../liara/client.js";
import { EP } from "../liara/endpoints.js";
import { unwrapRelease } from "../liara/release.js";
import { audited, bullets, faTime, result } from "./common.js";
import { parsePlans } from "./read.js";
import { assertPreflight } from '../liara/preflight-gate.js';
import { redact } from '../redact.js';
import { quoteCreate, assertQuoteUnchanged, quoteDisk, assertDiskQuoteUnchanged, type DiskQuote } from '../liara/plans.js';
import { createAppBody } from '../liara/create-app.js';
import { applyChosenPlan, describeCreatePlan, readPlanErrorCode, explainPlanError, type PlanChoiceItem } from '../liara/plan-choice.js';
import { replacementForCreateResult } from '../liara/plan-followup.js';
import { detectStack } from "../deploy/detect.js";
import {
  formatDiskCard,
  missingDiskSizeCard,
  parseRemoteDisks,
  planDiskMounts,
  type DiskCreateSpec,
  type DiskLine,
  type ReleaseDisk,
} from "../deploy/disks.js";
import { resolveProjectPath } from "../deploy/project-path.js";
import {
  ENV_CHANGE_WINDOW_SEC,
  diffEnv,
  envDiffSummary,
  findLatestEnvChange,
  getProjectEnvs,
  recordEnvChange,
  type EnvChangeCandidate,
  type EnvChangeKind,
  type EnvVar,
} from "../env-history.js";

export { getProjectEnvs };

const WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

/* ─────────────────────────── رجیستری عملیات ─────────────────────────── */

export interface ActionResult {
  text: string;
  structured?: Record<string, unknown>;
}

export interface ActionSpec {
  kind: string;
  risk: Risk;
  /** اثر عملیات روی سرویس */
  impact: string;
  /** خلاصهٔ فارسی برای نمایش به کاربر */
  describe(params: Record<string, unknown>): string;
  /** گزینه‌های انتخاب در elicitation */
  choices(params: Record<string, unknown>): ApprovalChoice[];
  /**
   * بررسی فقط‌خواندنی قبل از ساخت کارت تأیید. می‌تواند پارامترها را غنی کند
   * (مثل expectedKeys) یا اگر عملیات اصلاً منبع امنی ندارد، کارت راهنما
   * برگرداند و از ساخت تأیید بی‌مورد جلوگیری کند.
   */
  preflight?: (
    params: Record<string, unknown>,
  ) => Promise<
    | { ok: true; params: Record<string, unknown> }
    | { ok: false; result: ActionResult }
    | void
  >;
  /** اجرای عملیات */
  run(params: Record<string, unknown>): Promise<ActionResult>;
  /** آیا عملیات به اپ وابسته است؟ (بررسی allowlist) */
  appScoped?: boolean;
}

const ACTIONS = new Map<string, ActionSpec>();
const appName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const variable = z.object({ key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), value: z.string() });
const actionSchemas: Record<string, z.ZodType> = {
  liara_create_app: z.object({ name: appName, planID: z.string().min(1), platform: z.enum(['node','docker','python','static']), bundlePlanID: z.string().min(1), network: z.string().optional(), projectPath: z.string().optional() }),
  liara_create_network: z.object({ app: appName, networkName: appName }),
  liara_create_disk: z.object({ app: appName, name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/), size: z.string().regex(/^\d+(\.\d+)?$/) }),
  liara_deploy: z.object({ app: appName, path: z.string().min(1) }),
  liara_restart: z.object({ app: appName }),
  liara_scale: z.object({ app: appName, on: z.boolean() }),
  liara_resize: z.object({ app: appName, planID: z.string().min(1) }),
  liara_set_env: z.object({ app: appName, variables: z.array(variable), unset: z.array(z.string()).optional(), awaitingValues: z.boolean().optional() }),
  rollback_last_env_change: z.object({
    app: appName,
    incidentAt: z.string().min(1).optional(),
    windowSec: z.number().int().min(60).max(3600).optional(),
    /** فقط برای نمایش دقیق در کارت تأیید؛ اجرا دوباره diff را می‌سازد. */
    expectedKeys: z.array(z.string()).optional(),
  }),
  liara_add_domain: z.object({ app: appName, domain: z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i) }),
  liara_enable_ssl: z.object({ domain: z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i) }),
};

/** ساخت اپ هنوز owned نیست؛ تأیید high خودش دروازه است. بقیه باید allowlist یا owned باشند. */
export function appWriteAllowed(kind: string, app: string): boolean {
  // ساخت شبکه POST را فقط با networkName می‌زند (network/create.js:12) و همیشه کارت high می‌خواهد.
  if (kind === "liara_create_app" || kind === "liara_enable_ssl" || kind === "liara_create_network") return true;
  return isAllowedApp(app);
}

async function listProjectDomains(app: string): Promise<{ name?: string }[]> {
  const { data } = await liaraGet<any>(EP.listDomains, { query: { project: app } });
  const rows = Array.isArray(data) ? data : data?.domains ?? [];
  return rows as { name?: string }[];
}

export async function checkScope(
  kind: string,
  params: Record<string, unknown>,
  listDomains: (app: string) => Promise<{ name?: string }[]> = listProjectDomains,
): Promise<string | null> {
  if (kind !== "liara_enable_ssl" && !appWriteAllowed(kind, String(params.app ?? params.name ?? ""))) {
    return requireAllowedApp(String(params.app ?? params.name ?? ""));
  }
  if (kind !== "liara_enable_ssl") return null;
  const apps = [...new Set([...config.allowedApps, ...readOwnedApps()])];
  for (const app of apps) {
    const rows = await listDomains(app);
    if (rows.some((row) => row.name === params.domain)) return null;
  }
  return '❌ دامنه به هیچ اپ مجازی متصل نیست.';
}

function registerAction(spec: ActionSpec): void {
  ACTIONS.set(spec.kind, spec);
}

export function getAction(kind: string): ActionSpec | undefined {
  return ACTIONS.get(kind);
}

export function listActions(): string[] {
  return [...ACTIONS.keys()];
}

/** گزینه‌های استاندارد: تأیید/لغو */
const SIMPLE_CHOICES: ApprovalChoice[] = [
  { value: "approve", labelFa: "تأیید", descriptionFa: "اجرای عملیات روی لیارا" },
  { value: "cancel", labelFa: "لغو", descriptionFa: "بدون هیچ تغییری" },
];

/** کارت ۳ گزینه‌ای وقتی baseline سالم برای rollback دقیق وجود ندارد. */
export const ENV_RECOVERY_CHOICES: ApprovalChoice[] = [
  {
    value: "manual_set_env",
    labelFa: "الف) ورود دستی کلید مشکوک و مقدار قبلی (پیشنهادی)",
    recommended: true,
    descriptionFa:
      "کلید مشکوک و مقدار قبلی را وارد کنید؛ سپس با set_env و تأیید strict اعمال می‌شود.",
  },
  {
    value: "restart_with_warning",
    labelFa: "ب) ری‌استارت با هشدار",
    descriptionFa:
      "هشدار صریح: چون علت در env است، ری‌استارت به‌احتمال زیاد مشکل را رفع نمی‌کند.",
  },
  {
    value: "report_only",
    labelFa: "ج) هیچ کاری نکن و فقط گزارش بده",
    descriptionFa: "هیچ تغییری روی سرویس اعمال نمی‌شود.",
  },
];

export interface EnvRecoveryCard {
  text: string;
  structured: Record<string, unknown>;
}

/**
 * کارت انتخاب/تأیید بازیابی env. فقط کلید و مقدار ماسک‌شده را نشان می‌دهد؛
 * هیچ مقدار خامی در متن یا structured قرار نمی‌گیرد. این کارت خودش هیچ
 * نوشتنی انجام نمی‌دهد و برای هر اقدام واقعی، مسیر تأیید جداگانه لازم است.
 */
export function buildEnvRecoveryCard(
  app: string,
  current: EnvVar[],
  reasonFa = "baseline سالم env برای این اپ ثبت نشده است.",
): EnvRecoveryCard {
  const masked = current
    .map((row) => ({ key: row.key, value: maskValue(row.value) }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const keyLines = masked.length
    ? masked.map((row) => `• ${row.key}=${row.value}`).join("\n")
    : "• (فهرست env خالی است)";
  const summaryFa =
    `بازیابی env اپ «${app}» بدون baseline سالم — انتخاب یکی از ۳ گزینه`;
  const impact =
    "هیچ تغییری تا انتخاب شما و تأیید جداگانهٔ اقدام نوشتنی اعمال نمی‌شود.";
  const text = [
    "🛟 کارت تأیید/انتخاب بازیابی env",
    `⚠️ ${reasonFa}`,
    "ری‌استارت به‌تنهایی مشکل env را رفع نمی‌کند؛ بنابراین گزینهٔ پیش‌فرض نیست.",
    "",
    "کلیدهای فعلی env (مقادیر ماسک‌شده):",
    keyLines,
    "",
    "الف) پیشنهادی — بازیابی دستی: کلید مشکوک و مقدار قبلی‌اش را وارد کنید تا با set_env (پس از تأیید strict) اعمال شود.",
    "ب) ری‌استارت با هشدار صریح: احتمالاً مشکل env را رفع نمی‌کند و فقط سرویس را دوباره راه می‌اندازد.",
    "ج) هیچ کاری نکن و فقط گزارش بده.",
    "",
    `اثر: ${impact}`,
  ].join("\n");

  return {
    text,
    structured: {
      ok: false,
      code: "ENV_BASELINE_MISSING",
      action: "env_recovery_options",
      app,
      risk: "medium",
      summaryFa,
      impact,
      choices: ENV_RECOVERY_CHOICES,
      maskedEnv: masked,
      currentEnvKeys: masked.map((row) => row.key),
      approval: { mode: "choose-one", requiredForAnyWrite: true },
    },
  };
}

export async function buildEnvRecoveryCardFromApi(
  app: string,
  reasonFa?: string,
): Promise<EnvRecoveryCard> {
  const current = await getProjectEnvs(app);
  return buildEnvRecoveryCard(app, current, reasonFa);
}

/* ─────────────────────────── کمکی‌ها ─────────────────────────── */

async function findPlan(planID: string) {
  const { data } = await liaraGet<unknown>(EP.me);
  const plans = parsePlans(data);
  return plans.find((p) => p.planID === planID);
}

function requireAllowedApp(app: string | undefined): string | null {
  if (!app) return '❌ نام اپ الزامی است.';
  if (!isAllowedApp(app)) {
    return fa.appNotAllowed(app, config.allowedApps);
  }
  return null;
}

/** بعد از ساخت اپ، فقط نام کلیدها را روی کارت set_env می‌گذارد. مقدار چاپ نمی‌شود. */
export function envCardAfterCreate(app: string, projectPath: unknown): string {
  if (typeof projectPath !== "string" || !projectPath.trim()) return "";
  let keys: string[] = [];
  try {
    keys = detectStack(resolveProjectPath(projectPath), app).requiredEnv;
  } catch {
    return "";
  }
  if (!keys.length) return "";
  const record = createPendingApproval({
    tool: "liara_set_env",
    app,
    params: {
      app,
      variables: keys.map((key) => ({ key, value: "" })),
      unset: [],
      awaitingValues: true,
    },
    summaryFa: `تنظیم env اپ «${app}»؛ کلیدها: ${keys.join("، ")}. مقادیر در این کارت نیستند.`,
    risk: "medium",
    impact: "نوشتن متغیرهای محیطی فقط بعد از اینکه مقدارها را جدا بدهید. این کارت با مقدار خالی اجرا نمی‌شود.",
    choices: SIMPLE_CHOICES,
  });
  return [
    "کلیدهای env لازم (مقدار چاپ نمی‌شود):",
    ...keys.map((key) => `• ${key}`),
    pendingMessage(record),
    "مقدارها را در liara_set_env بدهید؛ این کارت تا آمدن مقدار اجرا نمی‌شود.",
  ].join("\n");
}

/**
 * ادغام متغیرهای محیطی.
 * قاعده: هیچ کلید موجودی نباید حذف شود مگر آنکه صریحاً در `unset` آمده باشد.
 * (API لیارا کل لیست را جایگزین می‌کند.)
 */
export function mergeEnvVars(
  current: { key: string; value: string }[],
  vars: { key: string; value: string }[],
  unset: string[] = [],
): { key: string; value: string }[] {
  const map = new Map(current.map((e) => [e.key, e.value]));
  for (const key of unset) map.delete(key);
  for (const v of vars) map.set(v.key, v.value);
  return [...map.entries()].map(([key, value]) => ({ key, value }));
}

export interface AppliedEnvChange {
  current: EnvVar[];
  merged: EnvVar[];
  changes: ReturnType<typeof diffEnv>;
  historyRecorded: boolean;
  historyId?: string;
}

/**
 * خواندن env فعلی، ادغام، نوشتن و ثبت تاریخچه.
 * این تابع فقط پس از عبور از دروازهٔ تأیید صدا زده می‌شود.
 */
export async function applyEnvChange(
  app: string,
  vars: EnvVar[],
  unset: string[],
  meta: { kind?: EnvChangeKind; stateDir?: string; at?: string } = {},
): Promise<AppliedEnvChange> {
  const current = await getProjectEnvs(app);
  const merged = mergeEnvVars(current, vars, unset);
  const changes = diffEnv(current, merged);

  if (!changes.length) {
    return { current, merged, changes, historyRecorded: false };
  }

  await liaraPost(EP.updateEnvs, {
    project: app,
    variables: merged.map(({ key, value }) => ({ key, value })),
  });

  let historyRecorded = false;
  let historyId: string | undefined;
  try {
    const record = recordEnvChange(app, current, merged, {
      kind: meta.kind ?? "set_env",
      ...(meta.stateDir ? { stateDir: meta.stateDir } : {}),
      ...(meta.at ? { at: meta.at } : {}),
    });
    historyRecorded = Boolean(record);
    historyId = record?.id;
  } catch {
    // ثبت تاریخچه نباید موفقیت تغییر env را رد کند؛ فقط rollback بعدی ممکن نیست.
    historyRecorded = false;
  }

  return { current, merged, changes, historyRecorded, ...(historyId ? { historyId } : {}) };
}

function envDiffText(changes: ReturnType<typeof diffEnv>): string {
  return changes
    .map((change) => {
      if (change.after === null) return `− ${change.key}`;
      if (change.before === null) return `+ ${change.key} = ${maskValue(change.after)}`;
      return `~ ${change.key}: ${maskValue(change.before)} → ${maskValue(change.after)}`;
    })
    .join("\n");
}

/**
 * برنامهٔ دقیق rollback: فقط کلیدهای همان change، با مقدار before.
 * اگر مقدار فعلی با after آن change فرق داشته باشد، برای جلوگیری از بازنویسی
 * یک تغییر جدیدتر، mismatch برمی‌گردد و هیچ نوشتنی نباید انجام شود.
 */
export function planEnvRollback(
  current: EnvVar[],
  change: Pick<EnvChangeCandidate, "changes">,
): { vars: EnvVar[]; unset: string[]; mismatches: string[] } {
  const currentMap = new Map(current.map((row) => [row.key, row.value]));
  const mismatches = change.changes
    .filter((item) => {
      const value = currentMap.has(item.key) ? currentMap.get(item.key)! : null;
      return value !== item.after;
    })
    .map((item) => item.key);
  const vars = change.changes
    .filter((item) => item.before !== null)
    .map((item) => ({ key: item.key, value: item.before! }));
  const unset = change.changes
    .filter((item) => item.before === null)
    .map((item) => item.key);
  return { vars, unset, mismatches };
}

/* ─────────────────────────── عملیات: ساخت اپ ─────────────────────────── */

registerAction({
  kind: 'liara_create_network', risk: 'high', appScoped: true,
  impact: 'ایجاد شبکهٔ داخلی در تیم لیارا؛ تعرفهٔ مستقل از API مشخص نشده است.',
  describe: p => `ساخت شبکهٔ داخلی «${p.networkName}» برای اپ آزمایشی «${p.app}».`,
  choices: () => SIMPLE_CHOICES,
  run: async p => {
    const {data} = await liaraPost(EP.networks, {networkName:p.networkName});
    return {text:'✅ درخواست ساخت شبکه پذیرفته شد؛ فهرست شبکه‌ها را بررسی کنید.',structured:{ok:true,networkName:p.networkName,raw:data}};
  },
});

registerAction({
  kind: "liara_create_app",
  risk: "high",
  impact: "ساخت اپ جدید (مصرف منابع و احتمال هزینهٔ پلن)",
  appScoped: true,
  describe: (p) => describeCreatePlan(p),
  choices: (p) => {
    const options = Array.isArray(p["planChoices"]) ? (p["planChoices"] as PlanChoiceItem[]) : [];
    if (!options.length) return SIMPLE_CHOICES;
    return [
      ...options.map((item) => ({ value: item.value, labelFa: item.labelFa, recommended: item.recommended })),
      { value: "cancel", labelFa: "لغو", descriptionFa: "بدون هیچ تغییری" },
    ];
  },
  run: async (p) => {
    const selected = applyChosenPlan(p, typeof p["chosen"] === "string" ? p["chosen"] : undefined);
    assertQuoteUnchanged(selected.quote, await quoteCreate(selected));
    p = selected;
    const name = String(p["name"] ?? "");
    const planID = String(p["planID"] ?? "");
    const platform = String(p["platform"] ?? "node");
    const bundlePlanID = String(p["bundlePlanID"] ?? "");
    const networkId = typeof p["network"] === "string" ? p["network"].trim() : "";
    if (!networkId) {
      return {
        text: "شناسهٔ شبکه در درخواست نیست. ساخت اپ پست نشد؛ CLI هم بدون شبکه به POST نمی‌رسد.",
        structured: { ok: false, code: "NETWORK_REQUIRED", planID, bundlePlanID },
      };
    }
    const readOnly = p["readOnlyRootFilesystem"];
    const body = createAppBody({
      name,
      planID,
      platform,
      bundlePlanID,
      networkId,
      readOnlyRootFilesystem: typeof readOnly === "boolean" ? readOnly : undefined,
    });
    try {
      const { data } = await liaraPost<Record<string, unknown>>(EP.createProject, body);
      const id = (data ?? {})["projectID"] ?? (data ?? {})["id"] ?? name;
      registerOwnedApp(name);
      const envCard = envCardAfterCreate(name, p["projectPath"]);
      return {
        text: [`✅ اپ «${name}» ساخته شد.`, `🆔 شناسه: ${String(id)}`, envCard].filter(Boolean).join("\n"),
        structured: { ok: true, name, planID, platform, id: String(id), owned: true, raw: data },
      };
    } catch (err) {
      const details = err instanceof LiaraError ? err.details : undefined;
      const planError = readPlanErrorCode(details) ?? readPlanErrorCode({ message: err instanceof Error ? err.message : "" });
      if (!planError) throw err;
      return {
        text: explainPlanError(planID, planError),
        structured: { ok: false, code: "PLAN_REJECTED", planError, planID, bundlePlanID, providerResponse: details ?? null },
      };
    }
  },
});

registerAction({
  kind: "liara_create_disk",
  risk: "high",
  impact: "ساخت دیسک دائمی روی اپ. اگر قیمت در API نباشد عددی حدس زده نمی‌شود.",
  appScoped: true,
  describe: (p) => {
    const quote = p["quote"] as DiskQuote | undefined;
    return `ساخت دیسک «${String(p["name"] ?? "")}» به اندازهٔ ${String(p["size"] ?? "")} روی «${String(p["app"] ?? "")}». ${quote?.note ?? ""}`.trim();
  },
  choices: () => SIMPLE_CHOICES,
  run: async (p) => {
    assertDiskQuoteUnchanged(p["quote"], await quoteDisk(p));
    const app = String(p["app"] ?? "");
    const name = String(p["name"] ?? "");
    const size = String(p["size"] ?? "");
    const { data } = await liaraPost<Record<string, unknown>>(EP.createDisk(app), { name, size });
    return {
      text: `درخواست ساخت دیسک «${name}» به اندازهٔ ${size} روی «${app}» پذیرفته شد.`,
      structured: { ok: true, app, name, size, raw: data },
    };
  },
});

/* ─────────────────────────── عملیات: دیپلوی ─────────────────────────── */

registerAction({
  kind: "liara_deploy",
  risk: "medium",
  impact: "بیلد و انتشار نسخهٔ جدید روی سرویس (سرویس برای چند ثانیه بازنشانی می‌شود)",
  appScoped: true,
  describe: (p) => {
    const folder = String(p["path"] ?? "");
    const lines = Array.isArray(p["diskLines"]) ? (p["diskLines"] as DiskLine[]) : [];
    const card = lines.length
      ? formatDiskCard({ releaseDisks: [], creates: [], blocked: [], lines })
      : "";
    const prices = Array.isArray(p["diskCreates"])
      ? (p["diskCreates"] as { name?: unknown; quote?: DiskQuote }[])
          .map((item) =>
            item.quote?.note ? `قیمت «${String(item.name ?? "")}»: ${item.quote.note}` : "",
          )
          .filter(Boolean)
      : [];
    const extra = [card, ...prices].filter(Boolean).join("\n");
    return `انتشار سورس پوشهٔ «${folder}» روی اپ «${String(p["app"] ?? "")}».${extra ? `\n${extra}` : ""}`;
  },
  choices: () => SIMPLE_CHOICES,
  preflight: async (p) => {
    let folder = "";
    try {
      folder = resolveProjectPath(String(p["path"] ?? ""));
    } catch {
      return;
    }
    const local = detectStack(folder).disks ?? [];
    if (!local.length) return;
    const listed = await liaraGet(EP.listDisks(String(p["app"] ?? "")));
    const remote = parseRemoteDisks(listed.data);
    if (!remote) {
      return {
        ok: false,
        result: {
          text: "پاسخ فهرست دیسک فیلد disks را که CLI می‌خواند نداشت. هیچ دیسکی ساخته نشد و release ارسال نشد.",
          structured: { ok: false, code: "DISK_LIST_UNRECOGNIZED" },
        },
      };
    }
    const plan = planDiskMounts(local, remote);
    if (plan.blocked.length) {
      const card = missingDiskSizeCard(plan.blocked);
      return { ok: false, result: card };
    }
    const diskCreates: (DiskCreateSpec & { quote?: DiskQuote })[] = [];
    for (const create of plan.creates) {
      const quote = await quoteDisk({ name: create.name, size: create.size });
      diskCreates.push({ ...create, quote });
    }
    const { diskCard: _diskCard, diskLines: _diskLines, releaseDisks: _releaseDisks, diskCreates: _diskCreates, ...rest } = p;
    return {
      ok: true,
      params: {
        ...rest,
        releaseDisks: plan.releaseDisks,
        diskCreates,
        diskLines: plan.lines,
      },
    };
  },
  run: async (p) => {
    const app = String(p["app"] ?? "");
    const src = String(p["path"] ?? ".");
    const { deploySourceToApp } = await import("./composite.js");
    return deploySourceToApp(app, src, {
      releaseDisks: Array.isArray(p["releaseDisks"]) ? (p["releaseDisks"] as ReleaseDisk[]) : undefined,
      diskCreates: Array.isArray(p["diskCreates"]) ? (p["diskCreates"] as (DiskCreateSpec & { quote?: DiskQuote })[]) : [],
      diskLines: Array.isArray(p["diskLines"]) ? (p["diskLines"] as DiskLine[]) : undefined,
    });
  },
});

/* ─────────────────────────── عملیات: متغیر محیطی ─────────────────────────── */

registerAction({
  kind: "liara_set_env",
  risk: "medium",
  impact: "نوشتن متغیرهای محیطی — سرویس ری‌استارت می‌شود و قطعی کوتاه دارد",
  appScoped: true,
  describe: (p) => {
    const vars = (p["variables"] as { key: string; value: string }[] | undefined) ?? [];
    const unset = (p["unset"] as string[] | undefined) ?? [];
    const parts = vars.map((v) => `${v.key}=${maskValue(v.value)}`);
    if (unset.length) parts.push(`حذف: ${unset.join("، ")}`);
    return `تنظیم متغیرهای محیطی روی اپ «${String(p["app"] ?? "")}»: ${parts.join("، ") || "—"}`;
  },
  choices: () => SIMPLE_CHOICES,
  run: async (p) => {
    const app = String(p["app"] ?? "");
    if (p["awaitingValues"] === true) {
      return {
        text: "مقادیر env از کاربر نیامده؛ هیچ درخواستی به لیارا فرستاده نشد.",
        structured: { ok: false, code: "ENV_VALUES_REQUIRED", app },
      };
    }
    const vars = (p["variables"] as { key: string; value: string }[] | undefined) ?? [];
    const unset = (p["unset"] as string[] | undefined) ?? [];

    const applied = await applyEnvChange(app, vars, unset, { kind: "set_env" });
    const diff = envDiffText(applied.changes);

    return {
      text: [
        applied.changes.length
          ? `✅ متغیرهای محیطی روی «${app}» به‌روزرسانی شد.`
          : `ℹ️ مقدار متغیرهای محیطی «${app}» تغییری لازم نداشت.`,
        `🔄 سرویس ری‌استارت می‌شود (مقادیر قبلی در فهرست کامل حفظ شدند).`,
        `📋 تغییرات:\n${diff || "—"}`,
        ...(applied.historyRecorded ? [] : ["⚠️ تاریخچهٔ محلی env ثبت نشد؛ rollback دقیق بعدی ممکن نیست."]),
      ].join("\n"),
      structured: {
        ok: true,
        app,
        changed: applied.changes.filter((c) => c.after !== null).map((c) => c.key),
        unset: applied.changes.filter((c) => c.after === null).map((c) => c.key),
        totalKeys: applied.merged.length,
        changedKeys: applied.changes.map((c) => c.key),
        historyRecorded: applied.historyRecorded,
        historyId: applied.historyId,
      },
    };
  },
});

/* ─────────────────────────── عملیات: rollback آخرین تغییر env ─────────────────────────── */

const recoveryCardFor = async (app: string, reasonFa: string) => {
  try {
    return await buildEnvRecoveryCardFromApi(app, reasonFa);
  } catch {
    return null;
  }
};

registerAction({
  kind: "rollback_last_env_change",
  risk: "medium",
  impact:
    "برگرداندن فقط کلیدهای تغییرکردهٔ env به مقدار baseline/تاریخچه — سرویس ری‌استارت می‌شود و قطعی کوتاه دارد",
  appScoped: true,
  preflight: async (p) => {
    const app = String(p["app"] ?? "");
    const incidentAt = String(p["incidentAt"] ?? new Date().toISOString());
    try {
      const windowRaw = Number(p["windowSec"] ?? ENV_CHANGE_WINDOW_SEC);
      const found = await findLatestEnvChange(app, incidentAt, {
        windowSec: Number.isFinite(windowRaw) ? windowRaw : ENV_CHANGE_WINDOW_SEC,
        includeBaseline: true,
      });
      if (!found || !found.revertable || !found.changes.length) {
        const reason = found
          ? `تغییر env در ${faTime(found.at)} دیده شد (منبع: ${found.source})، اما مقدار قبلی آن برای rollback دقیق در دسترس نیست.`
          : "تغییر env قابل‌بازگشتی قبل از رخداد پیدا نشد و baseline سالم هم برای این اپ در دسترس نیست.";
        const card = await recoveryCardFor(app, reason);
        if (card) {
          return { ok: false, result: { text: card.text, structured: card.structured } };
        }
        return {
          ok: false,
          result: {
            text: `ℹ️ ${reason}\nبرای جلوگیری از تغییر کورکورانه، rollback انجام نشد.`,
            structured: {
              ok: false,
              action: "env_recovery_options",
              // کارت ۳ گزینه‌ای است و نوشتنی انجام نمی‌دهد؛ watch باید آن را
              // not-required ثبت کند، نه error.
              code: "ENV_BASELINE_MISSING",
              source: found?.source,
            },
          },
        };
      }
      // کلیدهای تأییدشده در کارت strict قفل می‌شوند؛ اگر تا زمان اجرا
      // عوض شوند، run دوباره بررسی و متوقف می‌شود.
      return { ok: true, params: { ...p, expectedKeys: found.keys } };
    } catch (err) {
      return {
        ok: false,
        result: {
          text: `⚠️ بررسی منبع rollback ناموفق بود؛ هیچ تغییری اعمال نشد: ${(err as Error).message}`,
          structured: { ok: false, code: "ENV_PREFLIGHT_FAILED" },
        },
      };
    }
  },
  describe: (p) => {
    const at = p["incidentAt"] ? `قبل از ${faTime(String(p["incidentAt"]))}` : "در ۱۰ دقیقهٔ اخیر";
    const expected = Array.isArray(p["expectedKeys"])
      ? (p["expectedKeys"] as unknown[]).map(String).filter(Boolean)
      : [];
    const keys = expected.length ? ` — کلیدهای تغییرکرده: ${expected.join("، ")}` : "";
    return `برگرداندن آخرین تغییر env اپ «${String(p["app"] ?? "")}» ${at} (فقط کلیدهای همان تغییر)${keys}.`;
  },
  choices: () => SIMPLE_CHOICES,
  run: async (p) => {
    const app = String(p["app"] ?? "");
    const incidentAt = String(p["incidentAt"] ?? new Date().toISOString());
    if (!Number.isFinite(Date.parse(incidentAt))) {
      return {
        text: "⚠️ زمان شروع رخداد نامعتبر است؛ rollback انجام نشد.",
        structured: {
          ok: false,
          action: "env_recovery_options",
          code: "INVALID_INCIDENT_AT",
        },
      };
    }
    const windowSec = Number(p["windowSec"] ?? ENV_CHANGE_WINDOW_SEC);
    const found = await findLatestEnvChange(app, incidentAt, {
      windowSec: Number.isFinite(windowSec) ? windowSec : ENV_CHANGE_WINDOW_SEC,
      includeBaseline: true,
    });

    if (!found) {
      const reason =
        "تغییر env قابل‌بازگشتی قبل از رخداد پیدا نشد و baseline سالم هم برای این اپ در دسترس نیست.";
      const card = await recoveryCardFor(app, reason);
      return {
        text: card
          ? card.text
          : `ℹ️ ${reason}\nبرای جلوگیری از تغییر کورکورانه، rollback انجام نشد.`,
        structured: card?.structured ?? {
          ok: false,
          action: "env_recovery_options",
          code: "NO_RECENT_ENV_CHANGE",
        },
      };
    }

    if (!found.revertable || !found.changes.length) {
      const reason = `تغییر env در ${faTime(found.at)} دیده شد (منبع: ${found.source})، اما مقدار قبلی آن در تاریخچهٔ محلی یا baseline ثبت نشده است.`;
      const card = await recoveryCardFor(app, reason);
      return {
        text: card
          ? card.text
          : `ℹ️ ${reason}\nبرای جلوگیری از تغییر کورکورانه، rollback انجام نشد.`,
        structured: card?.structured ?? {
          ok: false,
          action: "env_recovery_options",
          code: "ENV_HISTORY_WITHOUT_VALUES",
          source: found.source,
          changeAt: found.at,
          keys: found.keys,
        },
      };
    }

    const expectedRaw = p["expectedKeys"];
    if (Array.isArray(expectedRaw)) {
      const expected = expectedRaw.map(String).sort();
      const actual = [...found.keys].sort();
      if (expected.length && expected.join("\u0000") !== actual.join("\u0000")) {
        const reason =
          "کلیدهای تغییرکرده از زمان ساخت کارت تأیید عوض شده‌اند؛ برای جلوگیری از بازنویسی تغییر جدیدتر، rollback انجام نشد.";
        const card = await recoveryCardFor(app, reason);
        return {
          text: card ? card.text : `⚠️ ${reason}`,
          structured: card?.structured ?? {
            ok: false,
            action: "env_recovery_options",
            code: "ENV_CHANGED_SINCE",
            changeAt: found.at,
            keys: [...found.keys, ...expected],
          },
        };
      }
    }

    const current = await getProjectEnvs(app);
    const plan = planEnvRollback(current, found);
    if (plan.mismatches.length) {
      const reason =
        "از زمان ثبت آن تغییر، مقدار env دوباره عوض شده است؛ برای جلوگیری از بازنویسی تغییر جدیدتر، rollback انجام نشد.";
      const card = await recoveryCardFor(app, reason);
      return {
        text: card ? card.text : `⚠️ ${reason}`,
        structured: card?.structured ?? {
          ok: false,
          action: "env_recovery_options",
          code: "ENV_CHANGED_SINCE",
          changeAt: found.at,
          keys: plan.mismatches,
        },
      };
    }

    const applied = await applyEnvChange(app, plan.vars, plan.unset, { kind: "rollback" });
    const diff = envDiffText(applied.changes);
    const summary = found.diff ?? envDiffSummary(found.changes);
    const sourceLabel = found.source === "baseline" ? "baseline سالم" : found.source;

    return {
      text: [
        found.source === "baseline"
          ? "✅ env اپ به snapshot سالم قبل از تغییر برگردانده شد."
          : "✅ آخرین تغییر env قبل از رخداد برگردانده شد.",
        `🕒 زمان تغییر: ${faTime(found.at)} — منبع: ${sourceLabel}`,
        ...(found.baselineAt ? [`🧪 baseline سالم: ${faTime(found.baselineAt)}`] : []),
        `📋 کلیدهای بازگردانده‌شده: ${found.changes.map((change) => change.key).join("، ")}`,
        `➕ اضافه‌شده (حذف می‌شود): ${summary.added.join("، ") || "—"}`,
        `➖ حذف‌شده (برمی‌گردد): ${summary.removed.join("، ") || "—"}`,
        `✏️ تغییرکرده (برمی‌گردد): ${summary.changed.join("، ") || "—"}`,
        "🔄 سرویس ری‌استارت می‌شود.",
        `📋 تغییرات:\n${diff || "—"}`,
        ...(applied.historyRecorded ? [] : ["⚠️ تاریخچهٔ محلی rollback ثبت نشد."]),
      ].join("\n"),
      structured: {
        ok: true,
        app,
        action: "rollback_last_env_change",
        changeId: found.id,
        changeAt: found.at,
        source: found.source,
        ...(found.baselineAt ? { baselineAt: found.baselineAt } : {}),
        keys: found.changes.map((change) => change.key),
        diff: summary,
        changedKeys: applied.changes.map((change) => change.key),
        historyRecorded: applied.historyRecorded,
        historyId: applied.historyId,
      },
    };
  },
});

/* ─────────────────────────── عملیات: ری‌استارت ─────────────────────────── */

registerAction({
  kind: "liara_restart",
  risk: "low",
  impact: "ری‌استارت سرویس — قطعی کوتاه (چند ثانیه)",
  appScoped: true,
  describe: (p) => `ری‌استارت سرویس اپ «${String(p["app"] ?? "")}» (حافظه پاک می‌شود، نشت موقتاً برطرف می‌گردد).`,
  choices: () => SIMPLE_CHOICES,
  run: async (p) => {
    const app = String(p["app"] ?? "");
    await liaraPost(EP.restart(app), {});
    return {
      text: [`✅ درخواست ری‌استارت «${app}» پذیرفته شد.`, "ℹ️ وضعیت نهایی هنوز تأیید نشده؛ verify_fix را اجرا کنید."].join("\n"),
      structured: { ok: true, app, action: "restart" },
    };
  },
});

/* ─────────────────────────── عملیات: مقیاس ─────────────────────────── */

registerAction({
  kind: "liara_scale",
  risk: "high",
  impact: "خاموش/روشن‌کردن سرویس — در حالت خاموش سایت از دسترس خارج می‌شود",
  appScoped: true,
  describe: (p) =>
    `${p["on"] === true ? "روشن‌کردن" : "خاموش‌کردن"} سرویس اپ «${String(p["app"] ?? "")}».`,
  choices: () => SIMPLE_CHOICES,
  run: async (p) => {
    const app = String(p["app"] ?? "");
    const on = p["on"] !== false;
    await liaraPost(EP.scale(app), { scale: on ? 1 : 0 });
    return {
      text: `✅ درخواست ${on ? 'روشن‌کردن' : 'خاموش‌کردن'} «${app}» پذیرفته شد؛ با liara_status نتیجه را بررسی کنید.`,
      structured: { ok: true, app, scale: on ? 1 : 0 },
    };
  },
});

/* ─────────────────────────── عملیات: ارتقای پلن ─────────────────────────── */

registerAction({
  kind: "liara_resize",
  risk: "high",
  impact: "تغییر پلن — احتمال افزایش هزینهٔ ماهانه و ری‌استارت سرویس",
  appScoped: true,
  describe: (p) =>
    `تغییر پلن اپ «${String(p["app"] ?? "")}» به ${String(p["planID"] ?? "?")}.`,
  choices: () => SIMPLE_CHOICES,
  run: async (p) => {
    const app = String(p["app"] ?? "");
    const planID = String(p["planID"] ?? "");
    const { data } = await liaraGet<Record<string, unknown>>(EP.getProject(app));
    const currentPlan = String((data ?? {})["plan"] ?? (data ?? {})["planID"] ?? "—");
    const { data: post } = await liaraPost<Record<string, unknown>>(EP.resize(app), { planID });
    return {
      text: [
        `✅ پلن اپ «${app}» از ${currentPlan} به ${planID} تغییر کرد.`,
        `📦 پاسخ API: ${JSON.stringify(post).slice(0, 300)}`,
      ].join("\n"),
      structured: { ok: true, app, from: currentPlan, to: planID, raw: post },
    };
  },
});

/* ─────────────────────────── عملیات: دامنه ─────────────────────────── */

registerAction({
  kind: "liara_add_domain",
  risk: "medium",
  impact: "افزودن دامنه به اپ — نیازمند تنظیم رکورد DNS و صدور SSL",
  appScoped: true,
  describe: (p) => `افزودن دامنهٔ «${String(p["domain"] ?? "")}» به اپ «${String(p["app"] ?? "")}».`,
  choices: () => SIMPLE_CHOICES,
  run: async (p) => {
    const app = String(p["app"] ?? "");
    const domain = String(p["domain"] ?? "");
    const { data } = await liaraPost<Record<string, unknown>>(EP.createDomain, {
      name: domain,
      project: app,
      type: "PROJECT",
    });
    const records = extractDnsRecords(data);
    const lines = [
      `✅ دامنهٔ «${domain}» به اپ «${app}» اضافه شد.`,
      records.length
        ? `📋 رکوردهای DNS موردنیاز:\n${records.map((r) => `• ${r.type} ${r.name} → ${r.value}`).join("\n")}`
        : "📋 پاسخ API رکورد DNS برنگرداند؛ آن را در پنل لیارا ببینید.",
    ];
    return {
      text: lines.join("\n"),
      structured: { ok: true, app, domain, dnsRecords: records, raw: data },
    };
  },
});

registerAction({
  kind: "liara_enable_ssl",
  risk: "low",
  impact: "فعال‌سازی گواهی SSL روی دامنه (فعال‌سازی گواهی رایگان)",
  appScoped: false,
  describe: (p) => `فعال‌سازی گواهی SSL برای دامنهٔ «${String(p["domain"] ?? "")}».`,
  choices: () => SIMPLE_CHOICES,
  run: async (p) => {
    const domain = String(p["domain"] ?? "");
    const { data } = await liaraPost<Record<string, unknown>>(EP.provisionSslCerts, { domain });
    return {
      text: [
        `✅ درخواست صدور گواهی SSL برای «${domain}» ثبت شد.`,
        "⏳ صدور گواهی زمان می‌برد؛ بعداً با liara_status وضعیت را بررسی کنید.",
      ].join("\n"),
      structured: { ok: true, domain, raw: data },
    };
  },
});

/** استخراج رکوردهای DNS از پاسخ لیارا (شکل‌های مختلف) */
export function extractDnsRecords(data: unknown): { type: string; name: string; value: string }[] {
  const out: { type: string; name: string; value: string }[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const o = node as Record<string, unknown>;
    const type = o["type"] ?? o["recordType"];
    const name = o["name"] ?? o["host"] ?? o["recordName"];
    const value = o["value"] ?? o["target"] ?? o["content"];
    if (typeof type === "string" && typeof name === "string" && value !== undefined) {
      out.push({ type, name, value: String(value) });
    }
    for (const v of Object.values(o)) {
      if (v && typeof v === "object") visit(v);
    }
  };
  visit(data);
  const seen = new Set<string>();
  return out.filter((r) => {
    const key = `${r.type}|${r.name}|${r.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* ─────────────────────────── اجرای محافظت‌شده ─────────────────────────── */

export interface GuardedOutcome {
  res: Awaited<ReturnType<typeof result>>;
  executed: boolean;
  approvalId?: string;
}

/** متن و payload رد شدن؛ دلیل در خروجی و در detail ممیزی می‌ماند. */
export function formatGuardedRejection(
  summaryFa: string,
  reason: string,
): { text: string; structured: Record<string, unknown> } {
  return {
    text: `${fa.rejected}\n${reason}\n📌 ${summaryFa}`,
    structured: { ok: false, code: "REJECTED", reason },
  };
}

/**
 * اجرای یک عملیات نوشتنی با دروازهٔ تأیید.
 * - اپ خارج از allowlist → رد بدون هیچ درخواستی.
 * - تأیید نشد → بدون هیچ درخواست نوشتنی.
 */
export async function runGuardedAction(
  kind: string,
  params: Record<string, unknown>,
): Promise<GuardedOutcome> {
  const spec = getAction(kind);
  if (!spec) {
    return { res: result(`❌ عملیات ناشناخته: ${kind}`, { ok: false }), executed: false };
  }

  // زمان پیشنهاد را مقید کن تا تأیید دیرهنگام، تغییر env جدیدتری را برنگرداند.
  if (kind === "rollback_last_env_change" && !params["incidentAt"]) {
    params = { ...params, incidentAt: new Date().toISOString() };
  }
  actionSchemas[kind]?.parse(params);
  const app = String(params['app'] ?? params['name'] ?? '') || undefined;
  const notAllowed = await checkScope(kind, params);
  if (notAllowed) {
    return { res: result(notAllowed, { ok: false, code: "APP_NOT_ALLOWLISTED" }), executed: false };
  }

  /*
   * preflight فقط‌خواندنی: پیش از ساخت کارت تأیید، منبع امن را بررسی و
   * پارامترهای نمایشی (مثل expectedKeys) را غنی می‌کند. اگر عملیات منبع
   * امنی ندارد، همان‌جا کارت راهنما برمی‌گردد و هیچ تأییدی ساخته نمی‌شود.
   */
  if (spec.preflight) {
    let pre: Awaited<ReturnType<NonNullable<ActionSpec["preflight"]>>>;
    try {
      pre = await spec.preflight(params);
    } catch (err) {
      return {
        res: result(`⚠️ بررسی پیش‌نیاز عملیات ناموفق بود؛ هیچ تغییری اعمال نشد: ${(err as Error).message}`, {
          ok: false,
          code: "PREFLIGHT_FAILED",
        }),
        executed: false,
      };
    }
    if (pre && pre.ok === false) {
      return {
        res: result(pre.result.text, pre.result.structured),
        executed: false,
      };
    }
    if (pre && pre.ok === true) params = pre.params;
  }

  if (kind === 'liara_create_app') params = { ...params, quote: await quoteCreate(params) };
  if (kind === 'liara_create_disk') params = { ...params, quote: await quoteDisk(params) };
  const summaryFa = spec.describe(params);
  const decision = decideApproval({ tool: kind, params, declaredRisk: spec.risk });

  /** اجرای عملیات با انتخاب مسیر تأییدشده یا خودکار. */
  const execute = async (approval: AuditApproval, autoNotice?: string) => {
    assertPreflight();
    const actionResult = await audited(kind, app, params, async () => {
      const action = await spec.run(params);
      const text = autoNotice ? `${autoNotice}\n${action.text}` : action.text;
      const structured = autoNotice
        ? {
            ...(action.structured ?? {}),
            approvalMode: "automatic",
            approvalPolicy: decision.policy,
            riskLevel: decision.risk,
            approvalNoticeFa: autoNotice,
          }
        : {
            ...(action.structured ?? {}),
            ...(approval === "approved" ? { approval: "approved" } : {}),
          };
      return result(text, structured);
    }, approval);
    return {
      res: actionResult,
      executed: !actionResult.isError && actionResult.structuredContent?.ok !== false,
    };
  };

  if (decision.requiresApproval) {
    const outcome = await requireApproval({
      tool: kind,
      app,
      params,
      summaryFa,
      risk: decision.risk,
      impact: spec.impact,
      choices: spec.choices(params),
    });

    if (outcome.mode === "rejected") {
      const formatted = formatGuardedRejection(summaryFa, outcome.reason ?? "کاربر لغو کرد.");
      return {
        res: result(formatted.text, formatted.structured),
        executed: false,
      };
    }

    if (outcome.mode === "approved" && outcome.choice) {
      params = { ...params, chosen: outcome.choice };
    }

    if (outcome.mode === "pending") {
      return {
        res: result(
          `${pendingMessage(outcome.record)}\n📌 ${summaryFa}`,
          { ok: false, code: "APPROVAL_REQUIRED", approval: redact(outcome.record) },
        ),
        executed: false,
        approvalId: outcome.record.approvalId,
      };
    }

    return execute('approved');
  }

  const autoNotice =
    decision.autoNoticeFa ??
    `🤖 اجرای خودکار طبق سیاست ${decision.policy} — ${decision.reasonFa}`;
  return execute(`auto:${decision.policy}`, autoNotice);
}

/* ─────────────────────────── ثبت ابزارها ─────────────────────────── */

/** اجرای رکورد تأییدشده. خطای پلن کارت تازه می‌سازد و POST دوم نمی‌زند. */
export async function executeStoredAction(approvalId: string) {
  const rec = getApproval(approvalId);
  if (!rec) {
    return result("❌ درخواست تأیید پیدا نشد.", { ok: false, code: "APPROVAL_NOT_FOUND" });
  }
  const check = validateApproval(rec);
  if (!check.ok) {
    const expired = rec.status === "expired" || isApprovalExpired(rec);
    return result(
      expired
        ? `❌ ${check.reason}\n🔄 برای ادامه یک کادر تأیید تازه لازم است؛ این درخواست منقضی هرگز خودکار تمدید نمی‌شود.`
        : `❌ ${check.reason}`,
      {
        ok: false,
        code: expired ? "APPROVAL_EXPIRED" : "APPROVAL_INVALID",
        ...(expired ? { freshApprovalRequired: true } : {}),
      },
    );
  }
  const spec = getAction(rec.tool);
  if (!spec) {
    return result(`❌ نوع عملیات ناشناخته: ${rec.tool}`, { ok: false, code: "UNKNOWN_ACTION" });
  }
  actionSchemas[rec.tool]?.parse(rec.params);
  const notAllowed = await checkScope(rec.tool, rec.params);
  if (notAllowed) return result(notAllowed, { ok: false, code: "APP_NOT_ALLOWLISTED" });

  assertPreflight();
  const consumed = consumeApproval(approvalId);
  if (!consumed.ok) {
    return result(`❌ ${consumed.reason}`, { ok: false, code: "APPROVAL_INVALID" });
  }

  const runParams = rec.chosen ? { ...rec.params, chosen: rec.chosen } : rec.params;
  const actionResult = await spec.run(runParams);
  if (rec.tool === "liara_create_app") {
    const follow = await replacementForCreateResult(runParams, {
      structuredContent: (actionResult.structured ?? {}) as Record<string, unknown>,
      text: actionResult.text,
    });
    if (follow) return follow;
  }
  return result(
    [fa.approved, actionResult.text].join("\n"),
    { approval: "approved", ...(actionResult.structured ?? {}) },
  );
}

export function registerWriteTools(server: McpServer): void {
  /* ── liara_create_app ────────────────────────────────────────────── */
  server.registerTool(
    "liara_create_app",
    {
      title: "ساخت اپ در لیارا",
      description:
        "ساخت اپ جدید در لیارا با پلن و پلتفرم مشخص (نیازمند تأیید — ممکن است هزینه ایجاد کند).",
      inputSchema: {
        name: z.string().min(1).describe("نام اپ"),
        planID: z.string().min(1).describe("شناسهٔ پلن (از liara_plans)"),
        bundlePlanID: z.string().min(1).describe('شناسهٔ بستهٔ فعال زیر کلید دقیق planID در plans.projectBundlePlans'),
        network: z.string().optional().describe('شناسهٔ شبکهٔ داخلی لیارا'),
        platform: z.enum(["node", "docker", "python", "static"]).default("node").describe("پلتفرم اجرا"),
        projectPath: z.string().optional().describe("مسیر مطلق پروژه برای تشخیص کلیدهای env بعد از ساخت"),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ name, planID, platform, bundlePlanID, network, projectPath }) =>
      audited(
        "liara_create_app",
        name,
        { name, planID, platform },
        async () => {
          const out = await runGuardedAction("liara_create_app", { name, planID, platform, bundlePlanID, network, projectPath });
          return out.res;
        },
        "auto",
      ),
  );

  server.registerTool(
    "liara_create_disk",
    {
      title: "ساخت دیسک روی اپ",
      description:
        "ساخت دیسک با POST /v1/projects/{name}/disks (OpenAPI createDisk). ریسک high و quote قبل از تأیید. اگر قیمت در GET /v1/me نباشد، عددی حدس زده نمی‌شود. mount در این ابزار انجام نمی‌شود.",
      inputSchema: {
        app: z.string().min(1).describe("نام اپ"),
        name: z.string().min(1).describe("نام دیسک"),
        size: z.string().regex(/^\d+(\.\d+)?$/).describe("اندازه به گیگابایت، رشته، مثل 2.5"),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ app, name, size }) =>
      audited("liara_create_disk", app, { app, name, size }, async () => {
        const out = await runGuardedAction("liara_create_disk", { app, name, size });
        return out.res;
      }),
  );

  /* ── liara_deploy ────────────────────────────────────────────────── */
  server.registerTool(
    "liara_deploy",
    {
      title: "دیپلوی سورس روی اپ",
      description:
        "بسته‌بندی پوشهٔ پروژه، آپلود روی لیارا و انتشار نسخهٔ جدید (نیازمند تأیید).",
      inputSchema: {
        app: z.string().min(1).describe("نام اپ در لیارا"),
        projectPath: z.string().optional().describe("مسیر مطلق پوشهٔ پروژه"),
        path: z.string().optional().describe("نام قدیمی projectPath؛ باید مطلق باشد"),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ app, path: src, projectPath }) => {
      let folder = "";
      try {
        folder = resolveProjectPath(projectPath || src || "");
      } catch (err) {
        return result((err as Error).message, { ok: false, code: "PROJECT_PATH_REQUIRED" });
      }
      return audited("liara_deploy", app, { app, path: folder }, async () => {
        const out = await runGuardedAction("liara_deploy", { app, path: folder });
        return out.res;
      });
    },
  );

  /* ── liara_set_env ───────────────────────────────────────────────── */
  server.registerTool(
    "liara_set_env",
    {
      title: "تنظیم متغیرهای محیطی اپ",
      description:
        "افزودن/به‌روزرسانی/حذف متغیر محیطی روی اپ (نیازمند تأیید). مقدارها قبل از ارسال خوانده و ادغام می‌شوند تا کلیدهای موجود پاک نشوند؛ سرویس ری‌استارت می‌شود.",
      inputSchema: {
        app: z.string().min(1).describe("نام اپ در لیارا"),
        variables: z
          .array(z.object({ key: z.string().min(1), value: z.string() }))
          .default([])
          .describe("متغیرهایی که باید تنظیم شوند"),
        unset: z.array(z.string()).default([]).describe("کلیدهایی که باید حذف شوند"),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ app, variables, unset }) =>
      audited("liara_set_env", app, { app, variables, unset }, async () => {
        const out = await runGuardedAction("liara_set_env", { app, variables, unset });
        return out.res;
      }),
  );

  /* ── rollback_last_env_change ───────────────────────────────────── */
  server.registerTool(
    "rollback_last_env_change",
    {
      title: "برگرداندن آخرین تغییر env",
      description:
        "آخرین تغییر متغیرهای محیطی قبل از رخداد را از تاریخچهٔ محلی یا snapshot سالم env پیدا می‌کند و فقط کلیدهای تغییرکرده را به مقدار قبلی برمی‌گرداند (نیازمند تأیید؛ risk=medium). اگر baseline/مقدار قبلی در دسترس نباشد، اجرا نمی‌شود و کارت ۳ گزینه‌ای بازیابی دستی env نمایش داده می‌شود؛ ری‌استارت پیشنهاد نمی‌شود.",
      inputSchema: {
        app: z.string().min(1).describe("نام اپ در لیارا"),
        incidentAt: z
          .string()
          .optional()
          .describe("زمان شروع رخداد (ISO)؛ برای جست‌وجوی تغییر قبل از آن"),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ app, incidentAt }) =>
      audited("rollback_last_env_change", app, { app, incidentAt }, async () => {
        const out = await runGuardedAction("rollback_last_env_change", { app, incidentAt });
        return out.res;
      }),
  );

  /* ── liara_restart ───────────────────────────────────────────────── */
  server.registerTool(
    "liara_restart",
    {
      title: "ری‌استارت سرویس",
      description: "ری‌استارت سرویس اپ در لیارا (نیازمند تأیید؛ راه‌حل سریع و موقت برای نشت حافظه).",
      inputSchema: {
        app: z.string().min(1).describe("نام اپ در لیارا"),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ app }) =>
      audited("liara_restart", app, { app }, async () => {
        const out = await runGuardedAction("liara_restart", { app });
        return out.res;
      }),
  );

  /* ── liara_scale ─────────────────────────────────────────────────── */
  server.registerTool(
    "liara_scale",
    {
      title: "روشن/خاموش‌کردن سرویس",
      description:
        "خاموش (scale=0) یا روشن (scale=1)‌کردن سرویس اپ (نیازمند تأیید — خاموش‌کردن باعث قطعی کامل سایت می‌شود).",
      inputSchema: {
        app: z.string().min(1).describe("نام اپ در لیارا"),
        on: z.boolean().describe("true = روشن، false = خاموش"),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ app, on }) =>
      audited("liara_scale", app, { app, on }, async () => {
        const out = await runGuardedAction("liara_scale", { app, on });
        return out.res;
      }),
  );

  /* ── liara_resize ────────────────────────────────────────────────── */
  server.registerTool(
    "liara_resize",
    {
      title: "تغییر پلن اپ",
      description:
        "تغییر پلن (ارتقا/تنزل) یک اپ لیارا (نیازمند تأیید — احتمال افزایش هزینه).",
      inputSchema: {
        app: z.string().min(1).describe("نام اپ در لیارا"),
        planID: z.string().min(1).describe("شناسهٔ پلن جدید (از liara_plans)"),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ app, planID }) =>
      audited("liara_resize", app, { app, planID }, async () => {
        const out = await runGuardedAction("liara_resize", { app, planID });
        return out.res;
      }),
  );

  /* ── liara_add_domain ────────────────────────────────────────────── */
  server.registerTool(
    "liara_add_domain",
    {
      title: "افزودن دامنه به اپ",
      description:
        "افزودن دامنهٔ شخصی به اپ لیارا (نیازمند تأیید). ثبت دامنه در IRNIC دستی است؛ این ابزار فقط اتصال دامنه به اپ را انجام می‌دهد.",
      inputSchema: {
        app: z.string().min(1).describe("نام اپ در لیارا"),
        domain: z.string().min(3).describe("نام دامنه، مثلاً demo.example.com"),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ app, domain }) =>
      audited("liara_add_domain", app, { app, domain }, async () => {
        const out = await runGuardedAction("liara_add_domain", { app, domain });
        return out.res;
      }),
  );

  /* ── liara_enable_ssl ────────────────────────────────────────────── */
  server.registerTool(
    "liara_enable_ssl",
    {
      title: "فعال‌سازی SSL دامنه",
      description: "درخواست صدور گواهی SSL رایگان برای دامنهٔ متصل به اپ (نیازمند تأیید).",
      inputSchema: {
        domain: z.string().min(3).describe("نام دامنه"),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ domain }) =>
      audited("liara_enable_ssl", domain, { domain }, async () => {
        const out = await runGuardedAction("liara_enable_ssl", { domain });
        return out.res;
      }),
  );

  /* ── propose_action / execute_action ─────────────────────────────── */
  server.registerTool(
    "propose_action",
    {
      title: "پیشنهاد یک عملیات (بدون اجرا)",
      description:
        "یک عملیات نوشتنی را به‌صورت «در انتظار تأیید» ثبت می‌کند و approvalId برمی‌گرداند. سپس با execute_action اجرا می‌شود. زمانی استفاده می‌شود که کلاینت MCP از elicitation پشتیبانی نمی‌کند.",
      inputSchema: {
        kind: z
          .string()
          .min(1)
          .describe(`نوع عملیات: ${listActions().join("، ")}`),
        app: z.string().optional().describe("نام اپ در لیارا"),
        params: z.record(z.string(), z.unknown()).default({}).describe("پارامترهای عملیات"),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ kind, app, params }) =>
      audited("propose_action", app, { kind, app, params }, async () => {
        const spec = getAction(kind);
        if (!spec) {
          return result(
            `❌ نوع عملیات ناشناخته: ${kind}\nانواع معتبر: ${listActions().join("، ")}`,
            { ok: false },
          );
        }
        let merged: Record<string, unknown> = app ? { ...params, app } : { ...params };
        // زمان پیشنهاد را مقید کن تا تأیید دیرهنگام، تغییر env جدیدتری را برنگرداند.
        if (kind === "rollback_last_env_change" && !merged["incidentAt"]) {
          merged = { ...merged, incidentAt: new Date().toISOString() };
        }
        actionSchemas[kind]?.parse(merged);
        const notAllowed = await checkScope(kind, merged);
        if (notAllowed) return result(notAllowed, { ok: false, code: "APP_NOT_ALLOWLISTED" });
        delete merged["releaseDisks"];
        delete merged["diskCreates"];
        delete merged["diskLines"];
        delete merged["diskCard"];
        if (spec.preflight) {
          try {
            const pre = await spec.preflight(merged);
            if (pre && pre.ok === false) return result(pre.result.text, pre.result.structured);
            if (pre && pre.ok === true) merged = pre.params;
          } catch (err) {
            return result(
              `⚠️ بررسی پیش‌نیاز ناموفق بود؛ هیچ تأییدی ساخته نشد: ${(err as Error).message}`,
              { ok: false, code: "PREFLIGHT_FAILED" },
            );
          }
        }

        if (kind === 'liara_create_app') merged = { ...merged, quote: await quoteCreate(merged) };

        const { createPendingApproval } = await import("../approval.js");
        const record = createPendingApproval({
          tool: kind,
          app,
          params: merged,
          summaryFa: spec.describe(merged),
          risk: effectiveRisk(kind, merged, spec.risk),
          impact: spec.impact,
          choices: spec.choices(merged),
        });
        return result(pendingMessage(record), {
          ok: false,
          code: "APPROVAL_REQUIRED",
          approval: record,
        });
      }),
  );

  server.registerTool(
    "execute_action",
    {
      title: "اجرای یک عملیات تأییدشده",
      description:
        "اجرای عملیاتی که پیش‌تر با propose_action ساخته شده (تک‌مصرف، با مهلت ۱۰ دقیقه و مقید به هش پارامترها).",
      inputSchema: {
        approvalId: z.string().min(1).describe("شناسهٔ تأیید"),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ approvalId }) =>
      audited("execute_action", undefined, { approvalId }, () => executeStoredAction(approvalId)),
  );

  /* ── liara_plan_price ────────────────────────────────────────────── */
  server.registerTool(
    "liara_plan_price",
    {
      title: "مقایسهٔ پلن‌ها",
      description:
        "نمایش پلن‌های موجود به‌همراه RAM/CPU/قیمت تا تفاوت پلن فعلی و پلن پیشنهادی روشن شود. فقط‌خواندنی.",
      inputSchema: {
        currentPlanID: z.string().optional().describe("پلن فعلی اپ (اختیاری)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ currentPlanID }) =>
      audited("liara_plan_price", currentPlanID, { currentPlanID }, async () => {
        const plan = currentPlanID ? await findPlan(currentPlanID) : undefined;
        const { data } = await liaraGet<unknown>(EP.me);
        const plans = parsePlans(data);
        const lines = plans.map(
          (p) =>
            `• ${p.planID}${p.name ? ` (${p.name})` : ""}${p.planID === currentPlanID ? " ← فعلی" : ""} — RAM: ${p.ramMB ? `${p.ramMB}MB` : "?"} | CPU: ${p.cpuCores ? `${p.cpuCores} هسته` : "?"}${p.price ? ` | ${p.price}` : ""}`,
        );
        return result(
          [
            `💳 پلن‌های حساب${currentPlanID ? ` (پلن فعلی: ${currentPlanID})` : ""}`,
            bullets(lines),
            plan ? `ℹ️ مشخصات پلن فعلی: ${JSON.stringify(plan)}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          { ok: true, plans, current: plan },
        );
      }),
  );

  /* ── liara_releases_status helper for build logs ─────────────────── */
  server.registerTool(
    "liara_release_status",
    {
      title: "وضعیت یک انتشار",
      description: "وضعیت و شناسهٔ یک release لیارا (برای پیگیری بیلد). فقط‌خواندنی.",
      inputSchema: {
        releaseID: z.string().min(1).describe("شناسهٔ انتشار"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ releaseID }) =>
      audited("liara_release_status", undefined, { releaseID }, async () => {
        const { data } = await liaraGet<Record<string, unknown>>(EP.getRelease(releaseID));
        const obj = unwrapRelease(data);
        const status = String(obj["status"] ?? obj["state"] ?? "—");
        return result(
          `🚀 انتشار ${releaseID} — وضعیت: ${status}${obj["created_at"] ? ` — ${faTime(String(obj["created_at"]))}` : ""}`,
          { ok: true, releaseID, status, raw: obj },
        );
      }),
  );
}
