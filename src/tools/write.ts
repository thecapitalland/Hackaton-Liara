/**
 * Agate-Liara — ابزارهای Tier B (نیازمند تأیید) و رجیستری عملیات.
 *
 * هر عملیات نوشتنی از یک مسیر واحد عبور می‌کند:
 *   بررسی اپ مجاز → ساخت خلاصهٔ فارسی → تأیید (elicitation یا fallback) → اجرا → ممیزی
 * به این ترتیب «لغو» هیچ درخواست نوشتنی به لیارا نمی‌فرستد.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config, isAllowedApp } from "../config.js";
import { fa, maskValue } from "../i18n/fa.js";
import {
  consumeApproval,
  getApproval,
  pendingMessage,
  requireApproval,
  validateApproval,
  type ApprovalChoice,
  type Risk,
} from "../approval.js";
import { liaraGet, liaraPost } from "../liara/client.js";
import { EP } from "../liara/endpoints.js";
import { audited, bullets, faTime, result } from "./common.js";
import { parsePlans } from "./read.js";
import { assertPreflight } from '../liara/preflight-gate.js';
import { redact } from '../redact.js';
import { quoteCreate, assertQuoteUnchanged, pairLabel } from '../liara/plans.js';

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
  /** اجرای عملیات */
  run(params: Record<string, unknown>): Promise<ActionResult>;
  /** آیا عملیات به اپ وابسته است؟ (بررسی allowlist) */
  appScoped?: boolean;
}

const ACTIONS = new Map<string, ActionSpec>();
const appName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const variable = z.object({ key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), value: z.string() });
const actionSchemas: Record<string, z.ZodType> = {
  liara_create_app: z.object({ name: appName, planID: z.string().min(1), platform: z.enum(['node','docker','python','static']), bundlePlanID: z.string().min(1), network: z.string().optional() }),
  liara_create_network: z.object({ app: appName, networkName: appName }),
  liara_deploy: z.object({ app: appName, path: z.string().min(1) }),
  liara_restart: z.object({ app: appName }),
  liara_scale: z.object({ app: appName, on: z.boolean() }),
  liara_resize: z.object({ app: appName, planID: z.string().min(1) }),
  liara_set_env: z.object({ app: appName, variables: z.array(variable), unset: z.array(z.string()).optional() }),
  liara_add_domain: z.object({ app: appName, domain: z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i) }),
  liara_enable_ssl: z.object({ domain: z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i) }),
};

async function checkScope(kind: string, params: Record<string, unknown>): Promise<string | null> {
  if (kind === 'liara_create_app') return requireAllowedApp(String(params.name ?? ''));
  if (kind !== 'liara_enable_ssl') return requireAllowedApp(String(params.app ?? params.name ?? ''));
  for (const app of config.allowedApps) {
    const { data } = await liaraGet<any>(EP.listDomains, { query: { project: app } });
    const rows = Array.isArray(data) ? data : data?.domains ?? [];
    if (rows.some((r: any) => r.name === params.domain)) return null;
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

/* ─────────────────────────── کمکی‌ها ─────────────────────────── */

async function getProjectEnvs(app: string): Promise<{ key: string; value: string }[]> {
  const { data } = await liaraGet<Record<string, unknown>>(EP.getProject(app));
  const project = (data?.project ?? data) as Record<string, unknown>;
  const envs = project["envs"];
  if (!Array.isArray(envs)) throw new Error('ساختار envs شناخته نشد؛ برای جلوگیری از حذف متغیرها عملیات متوقف شد.');
  return envs.map((e) => {
    if (e && typeof e === "object") {
      const o = e as Record<string, unknown>;
      return { key: String(o["key"] ?? ""), value: String(o["value"] ?? "") };
    }
    return { key: String(e), value: "" };
  });
}

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

/* ─────────────────────────── عملیات: ساخت اپ ─────────────────────────── */

registerAction({
  kind: 'liara_create_network', risk: 'medium', appScoped: true,
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
  risk: "medium",
  impact: "ساخت اپ جدید (مصرف منابع و احتمال هزینهٔ پلن)",
  appScoped: true,
  describe: (p) =>
    `ساخت اپ «${String(p.name)}»: ${pairLabel(p.quote as any)}؛ شبکهٔ ${String(p.network ?? 'نامشخص')}، پلتفرم ${String(p.platform)}.`,
  choices: () => SIMPLE_CHOICES,
  run: async (p) => {
    assertQuoteUnchanged(p.quote, await quoteCreate(p));
    const name = String(p["name"] ?? "");
    const planID = String(p["planID"] ?? "");
    const platform = String(p["platform"] ?? "node");
    const body: Record<string, unknown> = { name, planID, platform, ...(p.bundlePlanID ? { bundlePlanID: p.bundlePlanID } : {}), ...(p.network ? {network:p.network} : {}) };
    const { data } = await liaraPost<Record<string, unknown>>(EP.createProject, body);
    const id = (data ?? {})["projectID"] ?? (data ?? {})["id"] ?? name;
    return {
      text: [`✅ اپ «${name}» ساخته شد.`, `🆔 شناسه: ${String(id)}`].join("\n"),
      structured: { ok: true, name, planID, platform, id: String(id), raw: data },
    };
  },
});

/* ─────────────────────────── عملیات: دیپلوی ─────────────────────────── */

registerAction({
  kind: "liara_deploy",
  risk: "medium",
  impact: "بیلد و انتشار نسخهٔ جدید روی سرویس (سرویس برای چند ثانیه بازنشانی می‌شود)",
  appScoped: true,
  describe: (p) => `انتشار سورس پوشهٔ «${String(p["path"] ?? ".")}» روی اپ «${String(p["app"] ?? "")}».`,
  choices: () => SIMPLE_CHOICES,
  run: async (p) => {
    const app = String(p["app"] ?? "");
    const src = String(p["path"] ?? ".");
    // منطق دیپلوی در composite.ts پیاده شده است (deploySourceToApp)
    const { deploySourceToApp } = await import("./composite.js");
    return deploySourceToApp(app, src);
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
    const vars = (p["variables"] as { key: string; value: string }[] | undefined) ?? [];
    const unset = (p["unset"] as string[] | undefined) ?? [];

    const current = await getProjectEnvs(app);
    const merged = mergeEnvVars(current, vars, unset);
    const map = new Map(merged.map((e) => [e.key, e.value]));

    const diff = [
      ...vars.map((v) => `+ ${v.key} = ${maskValue(v.value)}`),
      ...unset.map((k) => `− ${k}`),
    ].join("\n");

    const body = {
      project: app,
      variables: [...map.entries()].map(([key, value]) => ({ key, value })),
    };
    await liaraPost(EP.updateEnvs, body);

    return {
      text: [
        `✅ متغیرهای محیطی روی «${app}» به‌روزرسانی شد.`,
        `🔄 سرویس ری‌استارت می‌شود (مقادیر قبلی در فهرست کامل حفظ شدند).`,
        `📋 تغییرات:\n${diff || "—"}`,
      ].join("\n"),
      structured: {
        ok: true,
        app,
        changed: vars.map((v) => v.key),
        unset,
        totalKeys: map.size,
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
  risk: "medium",
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
  risk: "medium",
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

  actionSchemas[kind]?.parse(params);
  const app = String(params['app'] ?? params['name'] ?? '') || undefined;
  const notAllowed = await checkScope(kind, params);
  if (notAllowed) {
    return { res: result(notAllowed, { ok: false, code: "APP_NOT_ALLOWLISTED" }), executed: false };
  }

  if (kind === 'liara_create_app') params = { ...params, quote: await quoteCreate(params) };
  const summaryFa = spec.describe(params);
  const outcome = await requireApproval({
    tool: kind,
    app,
    params,
    summaryFa,
    risk: spec.risk,
    impact: spec.impact,
    choices: spec.choices(params),
  });

  if (outcome.mode === "rejected") {
    return {
      res: result(`${fa.rejected}\n📌 ${summaryFa}`, { ok: false, code: "REJECTED" }),
      executed: false,
    };
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

  assertPreflight();
  const actionResult = await audited(kind, app, params, async () => {
    const action = await spec.run(params);
    return result(action.text, action.structured);
  }, 'approved');
  return {
    res: actionResult,
    executed: !actionResult.isError && actionResult.structuredContent?.ok !== false,
  };
}

/* ─────────────────────────── ثبت ابزارها ─────────────────────────── */

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
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ name, planID, platform, bundlePlanID, network }) =>
      audited(
        "liara_create_app",
        name,
        { name, planID, platform },
        async () => {
          const out = await runGuardedAction("liara_create_app", { name, planID, platform, bundlePlanID, network });
          return out.res;
        },
        "auto",
      ),
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
        path: z.string().default(".").describe("مسیر پوشهٔ پروژه روی دیسک"),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ app, path: src }) =>
      audited("liara_deploy", app, { app, path: src }, async () => {
        const out = await runGuardedAction("liara_deploy", { app, path: src });
        return out.res;
      }),
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
        actionSchemas[kind]?.parse(merged);
        const notAllowed = await checkScope(kind, merged);
        if (notAllowed) return result(notAllowed, { ok: false, code: "APP_NOT_ALLOWLISTED" });

        if (kind === 'liara_create_app') merged = { ...merged, quote: await quoteCreate(merged) };

        const { createPendingApproval } = await import("../approval.js");
        const record = createPendingApproval({
          tool: kind,
          app,
          params: merged,
          summaryFa: spec.describe(merged),
          risk: spec.risk,
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
      audited("execute_action", undefined, { approvalId }, async () => {
        const rec = getApproval(approvalId);
        if (!rec) {
          return result("❌ درخواست تأیید پیدا نشد.", { ok: false, code: "APPROVAL_NOT_FOUND" });
        }
        const check = validateApproval(rec);
        if (!check.ok) {
          return result(`❌ ${check.reason}`, { ok: false, code: "APPROVAL_INVALID" });
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

        const actionResult = await spec.run(rec.params);
        return result(
          [fa.approved, actionResult.text].join("\n"),
          { approval: "approved", ...(actionResult.structured ?? {}) },
        );
      }),
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
        const obj = (data ?? {}) as Record<string, unknown>;
        const status = String(obj["status"] ?? obj["state"] ?? "—");
        return result(
          `🚀 انتشار ${releaseID} — وضعیت: ${status}${obj["created_at"] ? ` — ${faTime(String(obj["created_at"]))}` : ""}`,
          { ok: true, releaseID, status, raw: obj },
        );
      }),
  );
}
