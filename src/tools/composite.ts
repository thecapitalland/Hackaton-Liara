/**
 * Agate-Liara — ابزارهای ترکیبی (سناریوهای کامل).
 *
 * deploy_project · diagnose · apply_fix · verify_fix · connect_domain
 * watch_after_deploy · guide_domain_registration · guide_rollback · guide_github_deploy
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config, isAllowedApp } from "../config.js";
import { fa } from "../i18n/fa.js";
import { liaraGet, liaraPost, uploadSource, LiaraError } from "../liara/client.js";
import { EP } from "../liara/endpoints.js";
import { detectCauses, parseEvents, parseLogs, parseSeries } from "../diagnose/detectors.js";
import { rankWithLlm } from "../diagnose/llm.js";
import { detectStack } from "../deploy/detect.js";
import { humanSize, packageSource } from "../deploy/package.js";
import { httpProbe, probeSummary, sleep } from "../probe.js";
import { askChoice } from "../approval.js";
import { bullets, faTime, result } from "./common.js";
import { extractDnsRecords, runGuardedAction } from "./write.js";
import { parsePlans } from "./read.js";
import { fetchPlanCatalog, pairLabel } from '../liara/plans.js';
import type {
  Evidence,
  Hypothesis,
  IncidentReport,
  LogLine,
  PlanLimits,
  Series,
} from "../types.js";
import { randomUUID } from "node:crypto";

const COMPOSITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/* ─────────────────────────── وضعیت انتشار ─────────────────────────── */

const SUCCESS_STATES = ["ready", "deployed", "success", "succeeded", "active", "finished", "completed"];
const FAILURE_STATES = ["failed", "fail", "error", "canceled", "cancelled", "aborted"];

function releaseState(raw: unknown): { status: string; ok?: boolean; failed?: boolean } {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const status = String(
    obj["status"] ?? obj["state"] ?? obj["phase"] ?? obj["deploymentStatus"] ?? "",
  ).toLowerCase();
  return {
    status: status || "unknown",
    ok: SUCCESS_STATES.some((s) => status.includes(s)),
    failed: FAILURE_STATES.some((s) => status.includes(s)),
  };
}

/** انتظار برای پایان بیلد با نمایش لاگ بیلد */
async function waitForRelease(
  releaseID: string,
  onProgress?: (line: string) => void,
  timeoutMs = 10 * 60_000,
): Promise<{ ok: boolean; status: string; tail: string[] }> {
  const deadline = Date.now() + timeoutMs;
  const tail: string[] = [];
  let lastSince = Date.now() - 60_000;

  while (Date.now() < deadline) {
    const { data } = await liaraGet<unknown>(EP.getRelease(releaseID));
    const state = releaseState(data);
    if (state.ok) return { ok: true, status: state.status, tail };
    if (state.failed) return { ok: false, status: state.status, tail };

    try {
      const logs = await liaraGet<unknown>(EP.buildLogs(releaseID), {
        query: { since: lastSince },
      });
      const lines = parseLogs(logs.data).map((l) => l.message);
      for (const line of lines.slice(-5)) {
        tail.push(line);
        onProgress?.(line);
      }
      lastSince = Date.now();
    } catch {
      /* لاگ بیلد ممکن است موقتاً در دسترس نباشد */
    }
    await sleep(3000);
  }
  return { ok: false, status: "timeout", tail };
}

/* ─────────────────────────── استقرار ─────────────────────────── */

export interface DeployOutcome {
  text: string;
  structured?: Record<string, unknown>;
}

/**
 * بسته‌بندی ← آپلود ← انتشار ← انتظار ← پروب.
 * توسط liara_deploy و deploy_project استفاده می‌شود.
 */
export async function deploySourceToApp(app: string, srcPath: string): Promise<DeployOutcome> {
  const lines: string[] = [];

  lines.push(`${fa.deployDetect}`);
  const detection = detectStack(srcPath, app);
  lines.push(
    `• پلتفرم: ${detection.platform} | پورت: ${detection.port ?? 3000}${detection.startCommand ? ` | اجرا: ${detection.startCommand}` : ""}`,
  );
  if (detection.requiredEnv.length) {
    lines.push(`• متغیرهای محیطی موردنیاز: ${detection.requiredEnv.join("، ")}`);
  }

  lines.push(fa.deployPackage);
  const packed = await packageSource(srcPath);
  lines.push(
    `• ${packed.fileCount} فایل — ${humanSize(packed.bytes)} (${packed.excluded.length} مورد مستثنا شد)`,
  );
  if (packed.bytes > config.maxArchiveBytes) {
    throw new Error(
      `حجم آرشیو (${humanSize(packed.bytes)}) از سقف ${humanSize(config.maxArchiveBytes)} بیشتر است.`,
    );
  }

  const archive = readFileSync(packed.archivePath);
  const { sourceID } = await uploadSource(app, archive);
  lines.push(`${fa.deployUpload} (${humanSize(packed.bytes)}) — source: ${sourceID}`);

  lines.push(fa.deployRelease);
  const releaseBody: Record<string, unknown> = {
    sourceID,
    port: detection.port ?? 3000,
    type: detection.platform,
    message: `Agate-Liara — ${new Date().toISOString()}`,
    build: {
      cache: true,
      args: {},
      location: ".",
      ...(detection.platform === "docker" ? { dockerfile: "Dockerfile" } : {}),
    },
  };
  const { data: releaseData } = await liaraPost<Record<string, unknown>>(
    EP.createRelease(app),
    releaseBody,
  );
  const releaseID = String(
    (releaseData ?? {})["releaseID"] ?? (releaseData ?? {})["id"] ?? (releaseData ?? {})["_id"] ?? "",
  );
  if (!releaseID) {
    throw new Error(
      `پاسخ ایجاد انتشار شناسهٔ releaseID نداشت: ${JSON.stringify(releaseData).slice(0, 300)}`,
    );
  }
  lines.push(`⏳ بیلد شروع شد — release: ${releaseID}`);

  const wait = await waitForRelease(releaseID, (l) => lines.push(`   ↳ ${l}`));
  if (!wait.ok) {
    lines.push(`${fa.deployFailed} — وضعیت: ${wait.status}`);
    return {
      text: lines.join("\n"),
      structured: { ok: false, app, releaseID, status: wait.status, stage: "build" },
    };
  }
  lines.push(`${fa.deployDone} — release: ${releaseID}`);

  // پروب سلامت با تا ۶۰ ثانیه تلاش مجدد
  const healthUrl = `https://${app}.liara.run`;
  let probeOk = false;
  let probeText = "";
  const probeDeadline = Date.now() + 60_000;
  while (Date.now() < probeDeadline) {
    const probe = await httpProbe(app, { path: "/health", count: 1 });
    if (!("error" in probe)) {
      probeText = probeSummary(probe);
      if (probe.ok) {
        probeOk = true;
        lines.push(`✅ سلامت: 200 در ${probe.p50 ?? "—"}ms`);
        break;
      }
    }
    await sleep(3000);
  }
  if (!probeOk) {
    lines.push(`⚠️ پروب سلامت موفق نشد:\n${probeText || "(بدون پاسخ)"}`);
  }

  lines.push(`${fa.deployLive}: ${healthUrl}`);
  lines.push(fa.deployRollbackHint);

  return {
    text: lines.join("\n"),
    structured: {
      ok: probeOk,
      app,
      releaseID,
      url: healthUrl,
      health: probeOk,
      platform: detection.platform,
      port: detection.port,
      requiredEnv: detection.requiredEnv,
    },
  };
}

/** ساخت اپ در صورت نبود + انتخاب پلن */
async function ensureApp(
  app: string,
  platform: string,
  desiredPlan?: string,
  bundlePlanID?: string,
  network?: string,
): Promise<{ app: string; created: boolean; planID?: string; note?: string }> {
  try {
    await liaraGet(EP.getProject(app));
    return { app, created: false };
  } catch (error) {
    if (!(error instanceof LiaraError) || error.status !== 404) throw error;
  }

  const catalog = await fetchPlanCatalog();
  if (!catalog.pairs.length) {
    return {
      app,
      created: false,
      note: "⚠️ فهرست پلن‌ها از API دریافت نشد؛ ساخت اپ ممکن نیست.",
    };
  }

  const options = catalog.pairs.slice(0,3);
  let chosen = desiredPlan && bundlePlanID ? catalog.pairs.find(p => p.planID === desiredPlan && p.bundlePlanID === bundlePlanID) : undefined;
  if (desiredPlan || bundlePlanID) {
    if (!chosen) throw new Error('ترکیب صریح planID و bundlePlanID باید زیر کلید دقیق API موجود و فعال باشد.');
  } else {
    const selection = await askChoice(`اپ «${app}» وجود ندارد؛ یک ترکیب پلن/بسته انتخاب کنید.`,
      options.map((p,i) => ({value: `${p.planID}/${p.bundlePlanID}`, labelFa: pairLabel(p), recommended:i===0})),
      'هزینهٔ منابع و بسته با هم نمایش داده شده؛ انتخاب به‌تنهایی مجوز ساخت نیست.');
    chosen = options.find(p => `${p.planID}/${p.bundlePlanID}` === selection);
    if (!chosen) return {app,created:false,note:`⏳ انتخاب ترکیب لازم است:\n${options.map(pairLabel).join('\n')}\nهر دو planID و bundlePlanID را صریحاً انتخاب کنید؛ هیچ تغییری اعمال نشد.`};
  }

  const out = await runGuardedAction("liara_create_app", {
    name: app,
    planID: chosen.planID,
    platform,
    bundlePlanID: chosen.bundlePlanID,
    network,
  });
  const ok = (out.res.structuredContent as { ok?: boolean } | undefined)?.ok === true;
  return { app, created: ok, planID: chosen.planID, note: ok ? undefined : String(out.res.content[0]?.type === 'text' ? out.res.content[0].text : '') };
}

/* ─────────────────────────── تشخیص ─────────────────────────── */

interface Baseline {
  incidentId: string;
  app: string;
  observedAt: string;
  planID?: string;
  probe: { url: string; p50: number | null; statuses: (number | null)[]; ok: boolean };
  cpu: { min: number; max: number; avg: number; last: number } | null;
  memory: { min: number; max: number; avg: number; last: number } | null;
  errorPattern?: string;
  errorsSeen: number;
}

function baselinePath(app: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(app)) throw new Error('نام اپ نامعتبر است.');
  const dir = config.stateDir;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return path.join(dir, `baseline-${app}.json`);
}

function saveBaseline(app: string, baseline: Baseline): void {
  mkdirSync(config.stateDir, { recursive: true });
  writeFileSync(baselinePath(app), JSON.stringify(baseline, null, 2), "utf8");
}

function loadBaseline(app: string): Baseline | null {
  try {
    if (!existsSync(baselinePath(app))) return null;
    return JSON.parse(readFileSync(baselinePath(app), "utf8")) as Baseline;
  } catch {
    return null;
  }
}

const ERROR_PATTERNS = [
  /TypeError:\s*Cannot read properties of undefined \(reading '([^']+)'\)/i,
  /ReferenceError:\s*(\w+) is not defined/i,
  /(\w+) is not a function/i,
  /Cannot read properties of undefined/i,
  /JavaScript heap out of memory/i,
  /\bECONNRESET\b/i,
  /\bETIMEDOUT\b/i,
];

/** استخراج الگوی خطای غالب از لاگ‌ها */
export function dominantErrorPattern(logs: LogLine[]): { pattern: string; count: number } | null {
  let best: { pattern: string; count: number } | null = null;
  for (const re of ERROR_PATTERNS) {
    const hits = logs.filter((l) => re.test(l.message));
    if (hits.length && (!best || hits.length > best.count)) {
      best = { pattern: re.source, count: hits.length };
    }
  }
  if (best) return best;
  const errorLogs = logs.filter((l) => l.level === "error");
  if (errorLogs.length) {
    return { pattern: errorLogs[errorLogs.length - 1]!.message.slice(0, 160), count: errorLogs.length };
  }
  return null;
}

interface DiagnosisBundle {
  incidentId: string;
  app: string;
  observedAt: string;
  logs: LogLine[];
  events: ReturnType<typeof parseEvents>;
  cpu: Series | null;
  memory: Series | null;
  probe: Awaited<ReturnType<typeof httpProbe>>;
  env: { defined: string[]; required: string[] } | null;
  plan: PlanLimits | null;
  evidence: Evidence[];
  hypotheses: Hypothesis[];
  notes: string[];
}

async function gatherDiagnosis(app: string, symptom?: string): Promise<DiagnosisBundle> {
  const notes: string[] = [];
  const observedAt = new Date().toISOString();

  /* لاگ‌ها */
  let logs: LogLine[] = [];
  try {
    const res = await liaraGet<unknown>(EP.logsV2(app), {
      query: {
        start: new Date(Date.now() - 15 * 60_000).toISOString(),
        direction: "forward",
        last_lines: 300,
      },
    });
    logs = parseLogs(res.data);
  } catch {
    try {
      const res = await liaraGet<unknown>(EP.logsV1(app), {
        query: { since: Date.now() - 15 * 60_000 },
      });
      logs = parseLogs(res.data);
    } catch (err) {
      notes.push("دریافت لاگ‌ها ناموفق بود؛ تحلیل بر پایهٔ شواهد ناقص است.");
    }
  }

  /* رویدادها */
  let events = parseEvents([]);
  try {
    const res = await liaraGet<unknown>(EP.events(app));
    events = parseEvents(res.data);
  } catch {
    notes.push("دریافت رویدادها ناموفق بود.");
  }

  /* متریک‌ها */
  let cpu: Series | null = null;
  let memory: Series | null = null;
  const [cpuRes, memRes] = await Promise.allSettled([
    liaraGet<unknown>(EP.metricsCpu(app), { query: { since: 30 } }),
    liaraGet<unknown>(EP.metricsMemory(app), { query: { since: 30 } }),
  ]);
  if (cpuRes.status === "fulfilled") cpu = parseSeries(cpuRes.value.data, "cpu", "%");
  else notes.push("متریک CPU در دسترس نبود.");
  if (memRes.status === "fulfilled") memory = parseSeries(memRes.value.data, "memory", "MB");
  else notes.push("متریک حافظه در دسترس نبود.");

  /* پروب */
  const probe = await httpProbe(app, { path: "/", count: 3 });
  if ("error" in probe) notes.push(probe.error);

  /* متغیرهای محیطی */
  let env: { defined: string[]; required: string[] } | null = null;
  let plan: PlanLimits | null = null;
  try {
    const res = await liaraGet<Record<string, unknown>>(EP.getProject(app));
    const obj = (res.data?.project ?? res.data ?? {}) as Record<string, unknown>;
    const envs = obj["envs"];
    const defined = Array.isArray(envs)
      ? envs.map((e) =>
          e && typeof e === "object" ? String((e as Record<string, unknown>)["key"] ?? "") : String(e),
        )
      : [];
    const currentPlanID = String(obj["plan"] ?? obj["planID"] ?? "");
    plan = currentPlanID ? planFromProject(obj, currentPlanID) : null;
    env = { defined: defined.filter(Boolean), required: [] };
  } catch {
    notes.push("اطلاعات اپ (متغیرها/پلن) در دسترس نبود.");
  }

  // Do not confuse the MCP server's own .env keys with those of the remote app.
  if (env) env.required = [...new Set(logs.flatMap(l => [...l.message.matchAll(/(?:missing env(?: variable)?\s+|ENV\s+)([A-Z][A-Z0-9_]+)/g)].map(m => m[1]!)))];

  const detectionResult = detectCauses({
    app,
    logs,
    events,
    cpu,
    memory,
    probe: "error" in probe ? null : probe,
    env,
    plan,
    collectedAt: observedAt,
  });

  /* LLM فقط رتبه‌بندی می‌کند */
  const llm = await rankWithLlm({
    app,
    symptom,
    hypotheses: detectionResult.hypotheses,
    evidence: detectionResult.evidence,
  });
  if (llm.note) notes.push(llm.note);

  return {
    incidentId: `inc_${randomUUID().slice(0, 8)}`,
    app,
    observedAt,
    logs,
    events,
    cpu,
    memory,
    probe,
    env,
    plan,
    evidence: detectionResult.evidence,
    hypotheses: llm.hypotheses,
    notes,
  };
}

function planFromProject(obj: Record<string, unknown>, planID: string): PlanLimits {
  return {
    planID,
    name: typeof obj["planName"] === "string" ? (obj["planName"] as string) : undefined,
    ramMB:
      typeof obj["memory"] === "number"
        ? (obj["memory"] as number)
        : typeof obj["ram"] === "number"
          ? (obj["ram"] as number)
          : undefined,
    cpuCores:
      typeof obj["cpu"] === "number"
        ? (obj["cpu"] as number)
        : typeof obj["cpus"] === "number"
          ? (obj["cpus"] as number)
          : undefined,
  };
}

/** قالب‌بندی گزارش رخداد (۳ سطر رتبه‌بندی + شواهد + گام بعدی) */
export function formatIncident(report: IncidentReport, extraNotes: string[] = []): string {
  const lines: string[] = [];
  lines.push(`${fa.diagnoseHeader(report.appId)}`);
  lines.push(`🆔 شناسهٔ رخداد: ${report.incidentId} — زمان مشاهده: ${faTime(report.observedAt)}`);
  lines.push("");

  if (!report.hypotheses.length) {
    lines.push(`❓ ${fa.noCause}`);
  } else {
    lines.push("| # | علت محتمل | اطمینان | نوع | شواهد |");
    lines.push("|---|-----------|---------|------|--------|");
    for (const h of report.hypotheses) {
      lines.push(
        `| ${h.rank} | ${h.cause} | ${Math.round(h.confidence * 100)}٪ | ${h.kind === "observed" ? fa.observed : fa.inferred} | ${h.evidenceIds.join("، ")} |`,
      );
    }
    lines.push("");
    for (const h of report.hypotheses) {
      lines.push(`• ${h.rank}) ${h.cause}`);
      for (const t of h.remedyText) lines.push(`   ↳ ${t}`);
    }
  }

  lines.push("");
  lines.push("🧾 شواهد:");
  for (const e of report.evidence) {
    lines.push(`• [${e.id}] (${e.source}${e.available ? "" : " — ناموجود"}) ${e.observation}`);
  }

  if (report.limitations.length) {
    lines.push("");
    lines.push("⚠️ محدودیت‌ها:");
    for (const l of report.limitations) lines.push(`• ${l}`);
  }
  if (extraNotes.length) {
    for (const n of extraNotes) lines.push(`ℹ️ ${n}`);
  }

  lines.push("");
  lines.push(`➡️ ${fa.nextStep}: برای اعمال راهکار، apply_fix را با incidentId="${report.incidentId}" و یکی از گزینه‌های پیشنهادی صدا بزنید.`);
  return lines.join("\n");
}

/* ─────────────────────────── یافتن محل باگ در کد ─────────────────────────── */

/** جست‌وجوی محل محتمل باگ در سورس پروژه بر اساس امضای خطا */
export function findCodeSuspects(
  root: string,
  errorSignature: string | undefined,
): { file: string; line: number; snippet: string; hint: string }[] {
  const out: { file: string; line: number; snippet: string; hint: string }[] = [];
  if (!errorSignature) return out;

  const propMatch = /reading '([^']+)'/.exec(errorSignature);
  const keywords = propMatch?.[1]
    ? [propMatch[1]]
    : errorSignature
        .replace(/[^\w\s.]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3)
        .slice(0, 3);

  const walk = (dir: string, depth = 0): void => {
    if (depth > 4) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (["node_modules", ".git", ".agate", "dist"].includes(entry)) continue;
      const full = path.join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!/\.(ts|js|mjs|cjs|tsx|jsx)$/i.test(full)) continue;
      let content: string;
      try {
        content = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const linesArr = content.split(/\r?\n/);
      for (let i = 0; i < linesArr.length; i++) {
        const line = linesArr[i]!;
        if (keywords.some((k) => line.includes(k))) {
          out.push({
            file: path.relative(root, full).replace(/\\/g, "/"),
            line: i + 1,
            snippet: line.trim().slice(0, 200),
            hint: `بررسی کنید که مقدار ورودی این خط می‌تواند undefined باشد (کلید مرتبط: ${keywords.join("، ")}).`,
          });
          if (out.length >= 8) return;
        }
      }
    }
  };
  walk(path.resolve(root));
  return out;
}

/* ─────────────────────────── ثبت ابزارها ─────────────────────────── */

export function registerCompositeTools(server: McpServer): void {
  /* ── deploy_project ──────────────────────────────────────────────── */
  server.registerTool(
    "deploy_project",
    {
      title: "استقرار کامل پروژه روی لیارا",
      description:
        "تشخیص استک پروژه → (در صورت نبود اپ) ساخت اپ با انتخاب پلن → بسته‌بندی و آپلود سورس → انتشار → پیگیری بیلد → بررسی سلامت آدرس زنده.",
      inputSchema: {
        path: z.string().default(".").describe("مسیر پوشهٔ پروژه"),
        app: z.string().default("agate-liara").describe("نام اپ در لیارا"),
        planID: z.string().optional().describe('پلن صریحاً انتخاب‌شده توسط کاربر؛ در نبود elicitation'),
        bundlePlanID: z.string().optional().describe('بستهٔ امکانات انتخاب‌شده'),
        network: z.string().optional().describe('شناسهٔ شبکهٔ داخلی انتخاب‌شده در لیارا'),
      },
      annotations: COMPOSITE_ANNOTATIONS,
    },
    async ({ path: src, app, planID, bundlePlanID, network }) => {
      const started = Date.now();
      try {
        if (!isAllowedApp(app)) {
          return result(fa.appNotAllowed(app, config.allowedApps), {
            ok: false,
            code: "APP_NOT_ALLOWLISTED",
          });
        }
        const detection = detectStack(src, app);
        const ensured = await ensureApp(app, detection.platform, planID, bundlePlanID, network);
        if (ensured.note) {
          return result(ensured.note, { ok: false, code: ensured.note.includes('نیاز به تأیید') ? 'APPROVAL_REQUIRED' : 'PLAN_SELECTION_REQUIRED' });
        }
        if (ensured.created) {
          // ادامه با ساخت اپ
        }
        const outcome = await runGuardedAction('liara_deploy', { app, path: src });
        return outcome.res;
      } catch (err) {
        return result(`❌ استقرار ناموفق بود: ${(err as Error).message}`, {
          ok: false,
          code: "DEPLOY_FAILED",
        });
      }
    },
  );

  /* ── diagnose ────────────────────────────────────────────────────── */
  server.registerTool(
    "diagnose",
    {
      title: "تشخیص علت رخداد با شواهد",
      description:
        "جمع‌آوری لاگ (۱۵ دقیقه)، متریک (۳۰ دقیقه)، رویدادها و ۳ پروب سلامت؛ سپس رتبه‌بندی ۳ علت محتمل با اطمینان و شناسهٔ شواهد + راهکارها. خروجی ساخت‌یافته = گزارش رخداد.",
      inputSchema: {
        app: z.string().min(1).describe("نام اپ در لیارا"),
        symptom: z.string().optional().describe("علائم گزارش‌شده توسط کاربر (اختیاری)"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ app, symptom }) => {
      try {
        const bundle = await gatherDiagnosis(app, symptom);
        const report: IncidentReport = {
          incidentId: bundle.incidentId,
          provider: "liara",
          appId: app,
          observedAt: bundle.observedAt,
          status: bundle.hypotheses.length ? "diagnosed" : "inconclusive",
          evidence: bundle.evidence,
          hypotheses: bundle.hypotheses,
          verification: null,
          limitations: [
            "لاگ لیارا استریم نمی‌شود؛ خواندن لاگ بر پایهٔ polling انجام می‌شود.",
            "نتیجهٔ تشخیص بر پایهٔ شواهد موجود در بازهٔ زمانی انتخابی است، نه دادهٔ کامل.",
          ],
        };

        // ذخیرهٔ baseline برای verify_fix
        const errPattern = dominantErrorPattern(bundle.logs);
        const probeOk = "error" in bundle.probe ? null : bundle.probe;
        saveBaseline(app, {
          incidentId: bundle.incidentId,
          app,
          observedAt: bundle.observedAt,
          planID: bundle.plan?.planID,
          probe: {
            url: probeOk?.url ?? "",
            p50: probeOk?.p50 ?? null,
            statuses: probeOk?.samples.map((s) => s.status) ?? [],
            ok: probeOk?.ok ?? false,
          },
          cpu: bundle.cpu ? seriesStats(bundle.cpu) : null,
          memory: bundle.memory ? seriesStats(bundle.memory) : null,
          errorPattern: errPattern?.pattern,
          errorsSeen: errPattern?.count ?? 0,
        });

        const text = formatIncident(report, bundle.notes);
        return result(text, { ok: true, ...report, incident: report } as unknown as Record<string, unknown>);
      } catch (err) {
        return result(`❌ تشخیص ناموفق بود: ${(err as Error).message}`, { ok: false });
      }
    },
  );

  /* ── apply_fix ───────────────────────────────────────────────────── */
  server.registerTool(
    "apply_fix",
    {
      title: "اعمال راهکار",
      description:
        "اعمال یکی از راهکارهای علت شناسایی‌شده: restart | resize | code_fix | set_env. عملیات نوشتنی نیازمند تأیید است؛ code_fix فقط دستورالعمل دقیق برای ایجنت می‌دهد.",
      inputSchema: {
        app: z.string().min(1).describe("نام اپ در لیارا"),
        incidentId: z.string().min(1).describe("شناسهٔ رخداد از diagnose"),
        option: z
          .enum(["restart", "resize", "code_fix", "set_env"])
          .describe("راهکار موردنظر"),
        planID: z.string().optional().describe("پلن جدید برای resize (اختیاری)"),
        variables: z
          .array(z.object({ key: z.string(), value: z.string() }))
          .optional()
          .describe("متغیرهای محیطی برای set_env (اختیاری)"),
      },
      annotations: COMPOSITE_ANNOTATIONS,
    },
    async ({ app, incidentId, option, planID, variables }) => {
      const baseline = loadBaseline(app);
      try {
        if (!baseline || baseline.incidentId !== incidentId) return result('❌ baseline متناظر رخداد پیدا نشد؛ diagnose را اجرا کنید.', { ok: false });
        if (option === "restart") {
          const out = await runGuardedAction("liara_restart", { app });
          return result(
            `${out.res.content?.[0]?.type === "text" ? out.res.content[0].text : ""}\n🆔 رخداد: ${incidentId}`,
            { incidentId, ...(out.res.structuredContent ?? {}) },
          );
        }

        if (option === "resize") {
          let target = planID;
          if (!target) {
            const { data } = await liaraGet<unknown>(EP.me);
            const plans = parsePlans(data);
            const current = baseline?.planID;
            const bigger = plans.find(
              (p) =>
                p.planID !== current &&
                (p.ramMB ?? 0) > (plans.find((x) => x.planID === current)?.ramMB ?? 0),
            );
            target = bigger?.planID ?? plans[plans.length - 1]?.planID ?? "";
          }
          if (!target) {
            return result("❌ پلن مناسبی برای ارتقا پیدا نشد؛ planID را دستی بدهید.", {
              ok: false,
            });
          }
          const out = await runGuardedAction("liara_resize", { app, planID: target });
          return result(
            `${out.res.content?.[0]?.type === "text" ? out.res.content[0].text : ""}\n🆔 رخداد: ${incidentId}`,
            { incidentId, ...(out.res.structuredContent ?? {}) },
          );
        }

        if (option === "set_env") {
          const vars = variables ?? [];
          if (!vars.length) {
            return result(
              "❌ برای set_env باید کلید و مقدار متغیرها را بدهید (variables).",
              { ok: false },
            );
          }
          const out = await runGuardedAction("liara_set_env", { app, variables: vars });
          return result(
            `${out.res.content?.[0]?.type === "text" ? out.res.content[0].text : ""}\n🆔 رخداد: ${incidentId}`,
            { incidentId, ...(out.res.structuredContent ?? {}) },
          );
        }

        /* code_fix — بدون نوشتن روی لیارا */
        const suspects = findCodeSuspects(process.cwd(), baseline?.errorPattern);
        const guidance = [
          `🛠️ اصلاح کد (راه‌حل دائمی) — رخداد ${incidentId}`,
          baseline?.errorPattern
            ? `الگوی خطای مشاهده‌شده: ${baseline.errorPattern}`
            : "الگوی خطای مشخصی ثبت نشده؛ کلیدهای پرکاربرد را بررسی کنید.",
          suspects.length
            ? "محل‌های محتمل در کد:"
            : "محل مشخصی پیدا نشد؛ محل‌های پرکاربرد را دستی بررسی کنید.",
          ...suspects.map(
            (s) => `• ${s.file}:${s.line} — «${s.snippet}»\n   ↳ ${s.hint}`,
          ),
          "",
          "✅ گام بعدی: فایل بالا را اصلاح کنید، سپس deploy_project را اجرا کنید و بعد verify_fix.",
        ].join("\n");
        return result(guidance, {
          ok: true,
          incidentId,
          option,
          suspects,
          nextAction: "edit code → deploy_project → verify_fix",
        });
      } catch (err) {
        return result(`❌ اعمال راهکار ناموفق بود: ${(err as Error).message}`, { ok: false });
      }
    },
  );

  /* ── verify_fix ──────────────────────────────────────────────────── */
  server.registerTool(
    "verify_fix",
    {
      title: "تأیید رفع مشکل",
      description:
        "پس از راهکار: ۳ پروب + مقایسهٔ متریک با baseline ثبت‌شده + بررسی ناپدیدشدن الگوی خطا. خروجی: تأییدشده یا مشکل باقی است، همراه جدول قبل/بعد.",
      inputSchema: {
        app: z.string().min(1).describe("نام اپ در لیارا"),
        incidentId: z.string().min(1).describe("شناسهٔ رخداد"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ app, incidentId }) => {
      const baseline = loadBaseline(app);
      if (!baseline || baseline.incidentId !== incidentId) return result('❌ baseline متناظر رخداد پیدا نشد؛ diagnose را اجرا کنید.', { ok: false });
      const probe = await httpProbe(app, { path: new URL(baseline.probe.url || `https://${app}.liara.run/`).pathname, count: 3 });
      const [cpuRes, memRes] = await Promise.allSettled([
        liaraGet<unknown>(EP.metricsCpu(app), { query: { since: 15 } }),
        liaraGet<unknown>(EP.metricsMemory(app), { query: { since: 15 } }),
      ]);
      const cpu = cpuRes.status === "fulfilled" ? parseSeries(cpuRes.value.data, "cpu", "%") : null;
      const memory = memRes.status === "fulfilled" ? parseSeries(memRes.value.data, "memory", "MB") : null;

      // بررسی ناپدیدشدن خطا
      let errorsNow: number | null = null;
      let logsNow: LogLine[] = [];
      try {
        const res = await liaraGet<unknown>(EP.logsV2(app), {
          query: {
            start: new Date(Math.max(Date.parse(baseline.observedAt), Date.now() - 5 * 60_000)).toISOString(),
            direction: "forward",
            last_lines: 100,
          },
        });
        logsNow = parseLogs(res.data);
        errorsNow = baseline.errorPattern ? logsNow.filter(l => new RegExp(baseline.errorPattern!, 'i').test(l.message)).length : logsNow.filter(l => l.level === 'error').length;
      } catch {
        /* لاگ در دسترس نبود → اثبات نبودِ خطا ممکن نیست */
      }

      const probeOk = "error" in probe ? null : probe;
      const nowStats = {
        cpu: cpu ? seriesStats(cpu) : null,
        memory: memory ? seriesStats(memory) : null,
        p50: probeOk?.p50 ?? null,
        ok: probeOk?.ok ?? false,
        errors: errorsNow,
      };
      const before = baseline;

      const table = [
        "| شاخص | قبل | بعد |",
        "|------|------|------|",
        `| وضعیت پروب | ${before?.probe.ok ? "✅ 200" : "❌ ناموفق"} | ${nowStats.ok ? "✅ 200" : "❌ ناموفق"} |`,
        `| p50 (ms) | ${before?.probe.p50 ?? "—"} | ${nowStats.p50 ?? "—"} |`,
        `| میانگین CPU | ${before?.cpu ? round(before.cpu.avg) : "—"} | ${nowStats.cpu ? round(nowStats.cpu.avg) : "—"} |`,
        `| میانگین حافظه (MB) | ${before?.memory ? round(before.memory.avg) : "—"} | ${nowStats.memory ? round(nowStats.memory.avg) : "—"} |`,
        `| تعداد خطا (۵ دقیقهٔ اخیر) | ${before?.errorsSeen ?? "—"} | ${nowStats.errors} |`,
      ].join("\n");

      const improved =
        nowStats.ok &&
        (before?.probe.ok === false || (before?.probe.p50 ?? Number.POSITIVE_INFINITY) >= (nowStats.p50 ?? 0)) &&
        nowStats.errors === 0 &&
        (nowStats.p50 ?? Infinity) < 1500 &&
        (before?.memory ? nowStats.memory !== null && nowStats.memory.last < before.memory.last : true);

      const verdict = improved ? fa.fixed : nowStats.ok ? fa.cannotVerify : fa.notFixed;
      const text = [
        `🔎 بررسی پس از اصلاح — رخداد ${incidentId}`,
        table,
        "",
        verdict,
        nowStats.ok
          ? `✅ سلامت: ${probeOk?.samples.map((s) => s.status).join("، ")} — p50=${nowStats.p50 ?? "—"}ms`
          : "❌ پروب سلامت موفق نبود.",
        baseline?.errorPattern ? `🔎 الگوی خطای قبلی: ${baseline.errorPattern}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      return result(text, {
        ok: true,
        incidentId,
        verified: improved,
        before: before ?? null,
        after: nowStats,
      });
    },
  );

  /* ── connect_domain ──────────────────────────────────────────────── */
  server.registerTool(
    "connect_domain",
    {
      title: "اتصال دامنه به اپ",
      description:
        "ثبت دامنه روی اپ (نیازمند تأیید)، نمایش رکوردهای DNS، بررسی وضعیت DNS و فعال‌سازی SSL (نیازمند تأیید). ثبت دامنه در IRNIC دستی است.",
      inputSchema: {
        app: z.string().min(1).describe("نام اپ در لیارا"),
        domain: z.string().min(3).describe("نام دامنه"),
      },
      annotations: COMPOSITE_ANNOTATIONS,
    },
    async ({ app, domain }) => {
      const lines: string[] = [];
      lines.push(
        `${fa.apiLimitation("ثبت دامنه در ایرنیک (IRNIC) دستی است؛ این ابزار فقط دامنه را به اپ لیارا وصل می‌کند.")}`,
      );

      const out = await runGuardedAction("liara_add_domain", { app, domain });
      const text = out.res.content?.[0]?.type === "text" ? out.res.content[0].text : "";
      lines.push(text);
      if (!out.executed) {
        lines.push("ℹ️ بدون تأیید، هیچ تغییری روی لیارا اعمال نشد.");
        return result(lines.join("\n"), { ok: false, ...(out.res.structuredContent ?? {}) });
      }

      const records = (out.res.structuredContent as { dnsRecords?: { type: string; name: string; value: string }[] })
        ?.dnsRecords ?? [];

      // بررسی وضعیت DNS
      let domainId: string | undefined;
      try {
        const res = await liaraGet<unknown>(EP.listDomains, { query: { project: app } });
        const rows = Array.isArray(res.data) ? res.data : (res.data as { domains?: unknown[] })?.domains ?? [];
        const found = (rows as Record<string, unknown>[]).find(
          (r) => String(r?.["name"] ?? "").toLowerCase() === domain.toLowerCase(),
        );
        domainId = found ? String(found["id"] ?? found["domainID"] ?? found["_id"] ?? "") : undefined;
        if (domainId) {
          const check = await liaraGet<unknown>(EP.checkDomain(domainId));
          lines.push(`🔎 وضعیت DNS: ${JSON.stringify(check.data).slice(0, 300)}`);
        }
      } catch {
        lines.push("🔎 بررسی وضعیت DNS ناموفق بود (دامنه شاید هنوز ثبت نشده باشد).");
      }

      if (records.length) {
        lines.push("📋 رکوردهای DNS موردنیاز (در پنل DNS دامنه ثبت کنید):");
        for (const r of records) lines.push(`• ${r.type} ${r.name} → ${r.value}`);
      }

      // فعال‌سازی SSL
      const ssl = await runGuardedAction("liara_enable_ssl", { domain });
      const sslText = ssl.res.content?.[0]?.type === "text" ? ssl.res.content[0].text : "";
      lines.push(sslText);

      lines.push("ℹ️ پس از ثبت رکوردهای DNS، با liara_status وضعیت SSL را بررسی کنید.");
      return result(lines.join("\n"), {
        ok: true,
        app,
        domain,
        dnsRecords: records,
        domainId,
      });
    },
  );

  /* ── watch_after_deploy ──────────────────────────────────────────── */
  server.registerTool(
    "watch_after_deploy",
    {
      title: "پایش کوتاه‌مدت پس از استقرار",
      description:
        "به‌مدت ۲ دقیقه، پروب سلامت و متریک‌ها را پایش می‌کند و هر ۱۵ ثانیه گزارش می‌دهد (کار خودکار کم‌ریسک پس از دیپلوی).",
      inputSchema: {
        app: z.string().min(1).describe("نام اپ در لیارا"),
        minutes: z.number().int().min(1).max(5).default(2).describe("مدت پایش به دقیقه"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ app, minutes }) => {
      const lines: string[] = [`👀 پایش «${app}» به‌مدت ${minutes} دقیقه...`];
      const deadline = Date.now() + minutes * 60_000;
      let healthy = 0;
      let checks = 0;
      const metrics: unknown[] = [];
      while (Date.now() < deadline) {
        const probe = await httpProbe(app, { path: "/health", count: 1 });
        try {
          const summary = await liaraGet(EP.metricsSummary(app));
          metrics.push({ at: new Date().toISOString(), summary: summary.data });
        } catch { metrics.push({ at: new Date().toISOString(), available: false }); }
        checks += 1;
        if ("error" in probe) {
          lines.push(`• ${faTime(new Date().toISOString())} — ❌ ${probe.error}`);
        } else {
          if (probe.ok) healthy += 1;
          lines.push(
            `• ${faTime(new Date().toISOString())} — ${probe.ok ? "✅" : "❌"} ${probe.samples[0]?.status ?? "—"} در ${probe.p50 ?? "—"}ms`,
          );
        }
        await sleep(15_000);
      }
      lines.push(
        `📊 خلاصه: ${healthy}/${checks} بررسی سالم بود.`,
        healthy === checks
          ? "✅ سرویس در کل بازهٔ پایش پایدار بود."
          : "⚠️ ناپایداری مشاهده شد — diagnose را اجرا کنید.",
      );
      return result(lines.join("\n"), { ok: true, app, healthy, checks, metrics });
    },
  );

  /* ── Tier C: راهنماها ────────────────────────────────────────────── */

  server.registerTool(
    "guide_domain_registration",
    {
      title: "راهنمای ثبت دامنه (IRNIC)",
      description:
        "مرحله‌به‌مرحلهٔ ثبت دامنه در IRNIC و اتصال آن به لیارا — چون API لیارا امکان خرید/ثبت دامنه ندارد.",
      inputSchema: {
        domain: z.string().optional().describe("دامنهٔ هدف (اختیاری)"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ domain }) =>
      result(
        [
          `${fa.apiLimitation("API لیارا دامنه ثبت/خریداری نمی‌کند؛ ثبت دامنه در IRNIC انجام می‌شود.")}`,
          "📋 گام‌ها:",
          "1) وارد irnic.ir شوید و یک دامنهٔ آزاد (.ir یا نام تجاری) جست‌وجو و خریداری کنید.",
          "2) در پنل دامنه، نام سرور (Name Server) را روی NSهای لیارا تنظیم کنید.",
          "3) سپس connect_domain را اجرا کنید تا دامنه به اپ وصل شود.",
          "4) رکوردهای DNS اعلام‌شده توسط لیارا (CNAME/A) را در پنل دامنه ثبت کنید.",
          "5) بررسی DNS: GET /v1/domains/{id}/check — و سپس فعال‌سازی SSL.",
          domain ? `🎯 دامنهٔ هدف: ${domain}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        { ok: true },
      ),
  );

  server.registerTool(
    "guide_rollback",
    {
      title: "راهنمای بازگشت به نسخهٔ قبلی",
      description:
        "لیارا endpoint رول‌بک ندارد؛ راه‌حل: پیدا کردن انتشار موفق قبلی و دیپلوی دوبارهٔ همان سورس (با تأیید).",
      inputSchema: {
        app: z.string().min(1).describe("نام اپ در لیارا"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ app }) => {
      try {
        const { data } = await liaraGet<unknown>(EP.listReleases(app));
        const rows = Array.isArray(data)
          ? data
          : ((data as { data?: unknown[] })?.data ?? []);
        const lines = rows.slice(-10).map((r) => {
          const o = (r ?? {}) as Record<string, unknown>;
          const id = String(o["releaseID"] ?? o["id"] ?? "—");
          const status = String(o["status"] ?? o["state"] ?? "—");
          const created = o["created_at"] ? faTime(String(o["created_at"])) : "—";
          const source = String(o["sourceID"] ?? o["source"] ?? "");
          return `• ${id} — ${status} — ${created}${source ? ` — source: ${source}` : ""}`;
        });
        return result(
          [
            `${fa.apiLimitation("endpoint رول‌بک در API لیارا وجود ندارد؛ باید سورس نسخهٔ قبلی دوباره دیپلوی شود.")}`,
            `📜 انتشارهای «${app}»:`,
            bullets(lines),
            "▶️ گام بعدی: آخرین انتشار موفق را انتخاب کنید و liara_deploy را با همان سورس اجرا کنید (تأیید لازم است).",
          ].join("\n"),
          { ok: true, app, releases: rows },
        );
      } catch (err) {
        return result(`❌ دریافت انتشارها ناموفق بود: ${(err as Error).message}`, { ok: false });
      }
    },
  );

  server.registerTool(
    "guide_github_deploy",
    {
      title: "راهنمای دیپلوی از گیت‌هاب",
      description:
        "لیارا دیپلوی مستقیم از گیت‌هاب ندارد؛ به‌جای آن یک GitHub Action آماده برای اجرای liara deploy تولید می‌شود.",
      inputSchema: {
        app: z.string().default("agate-liara").describe("نام اپ در لیارا"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ app }) => {
      const workflow = `name: Deploy to Liara

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install Liara CLI
        run: npm install -g @liara/cli
      - name: Deploy
        env:
          LIARA_API_TOKEN: \${{ secrets.LIARA_API_TOKEN }}
        run: liara deploy --api-token=\$LIARA_API_TOKEN --app=${app} --platform node --port 3000 --detach
`;
      return result(
        [
          `${fa.apiLimitation("دیپلوی مستقیم از گیت‌هاب در API لیارا وجود ندارد؛ از GitHub Action استفاده کنید.")}`,
          "📄 فایل `.github/workflows/liara.yml`:",
          "```yaml",
          workflow.trim(),
          "```",
          "🔐 توکن را در Settings → Secrets → Actions با نام LIARA_API_TOKEN ذخیره کنید (هرگز داخل مخزن نگذارید).",
        ].join("\n"),
        { ok: true, workflow },
      );
    },
  );
}

function seriesStats(s: Series): { min: number; max: number; avg: number; last: number } {
  const values = s.points.map((p) => p.value);
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    avg: values.reduce((a, b) => a + b, 0) / values.length,
    last: values[values.length - 1]!,
  };
}

function round(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}
