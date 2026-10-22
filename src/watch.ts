/**
 * Agate-Liara — پایش مداوم و رفع مشکل سیاست‌محور.
 *
 * هر چرخه:
 *  - سه مسیر مهم اپ را پروب می‌کند: `/`، `/api/challenges` و `/api/status`
 *  - خلاصهٔ متریک و رویدادها را می‌خواند
 *  - در صورت عبور از آستانه‌ها، diagnose را با ورودی env-blind اجرا می‌کند
 *  - اقدام درمانی کم‌خطر را از مسیر تأیید موجود (`runGuardedAction`) می‌فرستد
 *  - رخداد را در audit.jsonl ثبت و تا پایان cooldown از هشدار تکراری جلوگیری می‌کند
 *
 * این ماژول هیچ ورودی محیطی را برای تشخیص نمی‌خواند. اقدام درمانی این دمو
 * برگرداندن `BUG_MODE=off` است؛ این اقدام بخشی از تشخیص نیست و فقط پس از
 * تشخیص و از مسیر APPROVAL_POLICY اجرا/پیشنهاد می‌شود.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config, isAllowedApp } from "./config.js";
import { liaraGet } from "./liara/client.js";
import { EP } from "./liara/endpoints.js";
import { httpProbe } from "./probe.js";
import { parseEvents } from "./diagnose/detectors.js";
import type { EventItem, ProbeResult } from "./types.js";
import { runDiagnosis, type DiagnosisRun } from "./tools/composite.js";
import { runGuardedAction, type GuardedOutcome } from "./tools/write.js";
import { writeAudit, type AuditApproval, type AuditEntry } from "./audit.js";
import { faTime, firstText } from "./tools/common.js";

/** مسیرهایی که پایش پیش‌فرض باید هر چرخه بسنجد. */
export const WATCH_PATHS = ["/", "/api/challenges", "/api/status"] as const;

export interface WatchRouteResult {
  path: string;
  available: boolean;
  statuses: (number | null)[];
  sampleCount: number;
  p50: number | null;
  error?: string;
}

export interface WatchMetricsSummary {
  available: boolean;
  cpu: number | null;
  memory: number | null;
  note?: string;
}

export interface WatchSnapshot {
  at: string;
  routes: WatchRouteResult[];
  totalSamples: number;
  count500: number;
  rate500Pct: number;
  maxP50: number | null;
  maxP50Path: string | null;
  metrics: WatchMetricsSummary;
  events: EventItem[];
  eventsAvailable: boolean;
  eventNote?: string;
  limitations: string[];
}

export type WatchTriggerCode = "error500" | "slow" | "restart";

export interface WatchTrigger {
  code: WatchTriggerCode;
  detail: string;
  path?: string;
}

export interface WatchCooldown {
  active: boolean;
  until?: string;
  remainingSec?: number;
  previousIncidentId?: string;
}

export interface WatchRemediation {
  kind: "liara_set_env";
  executed: boolean;
  approvalId?: string;
  /** نتیجهٔ ممیزی: pending، approved، auto:balanced، … */
  approval: AuditApproval;
  auto: boolean;
  text: string;
}

export interface WatchIncident {
  incidentId: string;
  at: string;
  triggers: WatchTrigger[];
  diagnosis: DiagnosisRun | null;
  diagnosisError?: string;
  remediation: WatchRemediation | null;
  remediationSkippedReason?: string;
}

export interface WatchCheckResult {
  app: string;
  at: string;
  snapshot: WatchSnapshot;
  triggers: WatchTrigger[];
  newEvents: EventItem[];
  cooldown: WatchCooldown;
  incident: WatchIncident | null;
  reportFa: string;
}

export interface WatchState {
  app: string;
  lastCheckAt?: string;
  lastEventTsSec?: number;
  lastIncidentAt?: string;
  cooldownUntil?: string;
  lastIncidentId?: string;
  lastFingerprint?: string;
}

export interface WatchDeps {
  probeRoute?: (app: string, path: string) => Promise<ProbeResult | { error: string }>;
  readMetrics?: (app: string) => Promise<WatchMetricsSummary>;
  readEvents?: (app: string) => Promise<EventItem[]>;
  diagnose?: (app: string, symptom: string) => Promise<DiagnosisRun>;
  remediate?: (app: string) => Promise<GuardedOutcome>;
  audit?: (entry: AuditEntry) => void;
  now?: () => Date;
}

export interface WatchOptions {
  app: string;
  /** آیا در صورت تشخیص، اقدام درمانی سیاست‌محور انجام شود؟ */
  remediate?: boolean;
  /** برای تست/پیکربندی صریح؛ پیش‌فرض WATCH_COOLDOWN_SEC */
  cooldownSec?: number;
  /** پوشهٔ state؛ پیش‌فرض .agate */
  stateDir?: string;
  deps?: WatchDeps;
}

/* ─────────────────────────── state و cooldown ─────────────────────────── */

function assertAppName(app: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(app)) {
    throw new Error("نام اپ نامعتبر است.");
  }
}

export function watchStatePath(app: string, stateDir = config.stateDir): string {
  assertAppName(app);
  mkdirSync(stateDir, { recursive: true });
  return path.join(stateDir, `watch-${app}.json`);
}

export function loadWatchState(app: string, stateDir = config.stateDir): WatchState {
  const file = watchStatePath(app, stateDir);
  if (!existsSync(file)) return { app };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<WatchState>;
    return {
      app,
      lastCheckAt: typeof parsed.lastCheckAt === "string" ? parsed.lastCheckAt : undefined,
      lastEventTsSec:
        typeof parsed.lastEventTsSec === "number" && Number.isFinite(parsed.lastEventTsSec)
          ? parsed.lastEventTsSec
          : undefined,
      lastIncidentAt:
        typeof parsed.lastIncidentAt === "string" ? parsed.lastIncidentAt : undefined,
      cooldownUntil:
        typeof parsed.cooldownUntil === "string" ? parsed.cooldownUntil : undefined,
      lastIncidentId:
        typeof parsed.lastIncidentId === "string" ? parsed.lastIncidentId : undefined,
      lastFingerprint:
        typeof parsed.lastFingerprint === "string" ? parsed.lastFingerprint : undefined,
    };
  } catch {
    return { app };
  }
}

export function saveWatchState(state: WatchState, stateDir = config.stateDir): void {
  writeFileSync(watchStatePath(state.app, stateDir), JSON.stringify(state, null, 2), "utf8");
}

/** وضعیت cooldown را بدون تغییر state محاسبه می‌کند. */
export function cooldownStatus(
  state: WatchState,
  now: Date,
  cooldownSec = config.watchCooldownSec,
): WatchCooldown {
  if (cooldownSec <= 0) return { active: false };
  const nowMs = now.getTime();
  const untilMs = state.cooldownUntil ? Date.parse(state.cooldownUntil) : NaN;
  const fallbackMs = state.lastIncidentAt
    ? Date.parse(state.lastIncidentAt) + Math.max(0, cooldownSec) * 1000
    : NaN;
  const effectiveUntil = Number.isFinite(untilMs) ? untilMs : fallbackMs;
  if (!Number.isFinite(effectiveUntil) || nowMs >= effectiveUntil) {
    return { active: false };
  }
  return {
    active: true,
    until: new Date(effectiveUntil).toISOString(),
    remainingSec: Math.max(1, Math.ceil((effectiveUntil - nowMs) / 1000)),
    previousIncidentId: state.lastIncidentId,
  };
}

/* ─────────────────────────── آمار و آستانه‌ها ─────────────────────────── */

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

/** تبدیل نتیجهٔ httpProbe به شکل قابل گزارش/تست. */
export function routeResult(
  path: string,
  result: ProbeResult | { error: string },
): WatchRouteResult {
  if ("error" in result) {
    return {
      path,
      available: false,
      statuses: [],
      sampleCount: 0,
      p50: null,
      error: result.error,
    };
  }
  const statuses = result.samples.map((s) => s.status);
  const latencies = result.samples
    .map((s) => s.latencyMs)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return {
    path,
    available: true,
    statuses,
    sampleCount: result.samples.length,
    p50: result.p50 ?? median(latencies),
    ...(result.errorText ? { error: result.errorText } : {}),
  };
}

/** محاسبهٔ نرخ 500 و بیشترین p50 از نتایج مسیرها. */
export function computeWatchStats(routes: WatchRouteResult[]): Pick<
  WatchSnapshot,
  "totalSamples" | "count500" | "rate500Pct" | "maxP50" | "maxP50Path"
> {
  let totalSamples = 0;
  let count500 = 0;
  let maxP50: number | null = null;
  let maxP50Path: string | null = null;

  for (const route of routes) {
    totalSamples += route.sampleCount;
    count500 += route.statuses.filter((s) => s === 500).length;
    if (route.p50 !== null && (maxP50 === null || route.p50 > maxP50)) {
      maxP50 = route.p50;
      maxP50Path = route.path;
    }
  }

  const rate500Pct = totalSamples > 0 ? (count500 / totalSamples) * 100 : 0;
  return { totalSamples, count500, rate500Pct, maxP50, maxP50Path };
}

/**
 * آیا این رویداد نشانهٔ OOM/ری‌استارت/کرش است؟
 *
 * عمداً `kill`، `die`، `stop` و `destroy` تنها و بدون نشانهٔ صریح، trigger
 * نمی‌شوند: لیارا این وضعیت‌ها را در چرخهٔ عادی هر release هم برمی‌گرداند.
 * در غیر این صورت هر دیپلوی/چرخش release یک هشدار کاذب می‌سازد.
 */
export function isRestartEvent(event: EventItem): boolean {
  return /\b(oom|oomkilled|out of memory|memory limit|exit code 137|restart(?:ed|ing)?|crash(?:ed|ing)?|crashloop|unhealthy|backoff)\b/i.test(
    `${event.type} ${event.message}`,
  );
}

/**
 * آستانه‌ها:
 *  - نرخ 500 اکیداً بیشتر از ۵٪
 *  - p50 هر مسیر اکیداً بیشتر از ۱۵۰۰ms
 *  - رویداد جدید OOM/restart
 */
export function detectWatchTriggers(
  snapshot: WatchSnapshot,
  newEvents: EventItem[],
): WatchTrigger[] {
  const triggers: WatchTrigger[] = [];

  if (snapshot.rate500Pct > 5) {
    triggers.push({
      code: "error500",
      detail: `نرخ 500 برابر ${snapshot.rate500Pct.toFixed(1)}٪ است (${snapshot.count500} از ${snapshot.totalSamples}) و از آستانهٔ ۵٪ گذشته است.`,
    });
  }

  for (const route of snapshot.routes) {
    if (route.p50 !== null && route.p50 > 1500) {
      triggers.push({
        code: "slow",
        path: route.path,
        detail: `p50 مسیر ${route.path} برابر ${Math.round(route.p50)}ms است و از آستانهٔ ۱۵۰۰ms گذشته است.`,
      });
    }
  }

  const restarts = newEvents.filter(isRestartEvent);
  if (restarts.length) {
    const sample = restarts
      .slice(0, 3)
      .map((e) => `${e.type}${e.ts ? ` @${e.ts}` : ""}`)
      .join("، ");
    triggers.push({
      code: "restart",
      detail: `${restarts.length} رویداد OOM/ری‌استارت جدید دیده شد: ${sample}`,
    });
  }

  return triggers;
}

/** امضای پایدار مجموعهٔ triggerها برای تشخیص «هشدار تکراری». */
export function triggersFingerprint(triggers: WatchTrigger[]): string {
  return triggers
    .map((t) => `${t.code}:${t.path ?? ""}`)
    .sort()
    .join("|");
}

export function eventTimestampSec(event: EventItem): number | null {
  const raw = event.ts?.trim();
  if (!raw) return null;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    return Math.floor(numeric > 1e12 ? numeric / 1000 : numeric);
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function newestEventSec(events: EventItem[]): number | null {
  let newest: number | null = null;
  for (const event of events) {
    const ts = eventTimestampSec(event);
    if (ts !== null && (newest === null || ts > newest)) newest = ts;
  }
  return newest;
}

/* ─────────────────────────── خواندن پیش‌فرض ─────────────────────────── */

async function defaultProbeRoute(
  app: string,
  path: string,
): Promise<ProbeResult | { error: string }> {
  return httpProbe(app, { path, count: 3 });
}

/** استخراج عدد از شکل‌های مختلف خلاصهٔ متریک؛ واحد را حدس نمی‌زند. */
export function summaryNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  if (Array.isArray(value)) {
    // شکل رسمی: [{ value: [timestamp, "number"], applet: "..." }, ...]
    let latest: { ts: number; value: number } | null = null;
    for (const item of value) {
      const pair = Array.isArray(item)
        ? item
        : item && typeof item === "object" && Array.isArray((item as Record<string, unknown>)["value"])
          ? ((item as Record<string, unknown>)["value"] as unknown[])
          : null;
      if (!pair || pair.length < 2) continue;
      const ts = Number(pair[0]);
      const num = Number(pair[1]);
      if (!Number.isFinite(num)) continue;
      if (!latest || (Number.isFinite(ts) && ts >= latest.ts)) {
        latest = { ts: Number.isFinite(ts) ? ts : 0, value: num };
      }
    }
    return latest?.value ?? null;
  }
  if (value && typeof value === "object") {
    return summaryNumber((value as Record<string, unknown>)["value"]);
  }
  return null;
}

function numberFrom(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const num = summaryNumber(obj[key]);
    if (num !== null) return num;
  }
  return null;
}

async function defaultReadMetrics(app: string): Promise<WatchMetricsSummary> {
  try {
    const { data } = await liaraGet<Record<string, unknown>>(EP.metricsSummary(app));
    const summary = (data?.["summary"] ?? data ?? {}) as Record<string, unknown>;
    return {
      available: true,
      cpu: numberFrom(summary, ["cpuUsage", "cpu", "cpuPercent", "cpu_percent"]),
      memory: numberFrom(summary, ["memoryUsage", "memory", "memoryMB", "memory_mb", "rss"]),
    };
  } catch {
    return {
      available: false,
      cpu: null,
      memory: null,
      note: "خلاصهٔ متریک در دسترس نبود؛ فقط پروب و رویدادها بررسی شدند.",
    };
  }
}

async function defaultReadEvents(app: string): Promise<EventItem[]> {
  const { data } = await liaraGet<unknown>(EP.events(app));
  return parseEvents(data);
}

async function defaultDiagnose(app: string, symptom: string): Promise<DiagnosisRun> {
  return runDiagnosis(app, symptom);
}

/**
 * اقدام درمانی کم‌خطر این دمو: برگرداندن BUG_MODE به off.
 * این مقدار فقط پس از تشخیص استفاده می‌شود و از همان موتور تأیید عبور می‌کند؛
 * در strict کادر تأیید، در balanced اجرای خودکار low و در auto خودکار است.
 */
async function defaultRemediate(app: string): Promise<GuardedOutcome> {
  return runGuardedAction("liara_set_env", {
    app,
    variables: [{ key: "BUG_MODE", value: "off" }],
  });
}

/* ─────────────────────────── اجرای یک چرخه ─────────────────────────── */

/** نتیجهٔ اقدام درمانی را به مقدار ممیزی امن تبدیل می‌کند. */
export function remediationAudit(outcome: GuardedOutcome | null): AuditApproval {
  if (!outcome) return "not-required";
  const content = (outcome.res.structuredContent ?? {}) as Record<string, unknown>;
  if (content["code"] === "APPROVAL_REQUIRED") return "pending";
  if (content["code"] === "REJECTED") return "rejected";
  if (content["approvalMode"] === "automatic") {
    const policy = String(content["approvalPolicy"] ?? "");
    if (policy === "strict" || policy === "balanced" || policy === "auto") {
      return `auto:${policy}`;
    }
  }
  if (!outcome.executed) return "error";
  return "approved";
}

function remediationFromOutcome(outcome: GuardedOutcome): WatchRemediation {
  const approval = remediationAudit(outcome);
  return {
    kind: "liara_set_env",
    executed: outcome.executed,
    ...(outcome.approvalId ? { approvalId: outcome.approvalId } : {}),
    approval,
    auto: approval.startsWith("auto:"),
    text: firstText(outcome.res),
  };
}

function formatMetric(value: number | null): string {
  if (value === null) return "—";
  if (value === 0) return "0";
  if (Math.abs(value) < 0.01) return value.toPrecision(3);
  return String(Math.round(value * 100) / 100);
}

function formatRoutes(routes: WatchRouteResult[]): string[] {
  return routes.map((route) => {
    if (!route.available) {
      return `• ${route.path}: ناموجود${route.error ? ` (${route.error})` : ""}`;
    }
    return `• ${route.path}: ${route.statuses.map((s) => s ?? "—").join("، ")} | p50=${route.p50 ?? "—"}ms`;
  });
}

function formatWatchReport(result: Omit<WatchCheckResult, "reportFa">): string {
  const { app, at, snapshot, triggers, newEvents, cooldown, incident } = result;
  const lines: string[] = [
    `👀 پایش خودکار «${app}» — ${faTime(at)}`,
    "",
    "🌐 پروب مسیرها:",
    ...formatRoutes(snapshot.routes),
    `📊 نرخ 500: ${snapshot.rate500Pct.toFixed(1)}٪ (${snapshot.count500}/${snapshot.totalSamples}) | بیشترین p50: ${
      snapshot.maxP50 === null ? "—" : `${Math.round(snapshot.maxP50)}ms (${snapshot.maxP50Path})`
    }`,
    snapshot.metrics.available
      ? `📈 متریک خلاصه (واحد خام API): CPU=${formatMetric(snapshot.metrics.cpu)} | حافظه=${formatMetric(snapshot.metrics.memory)}`
      : `📈 متریک خلاصه: ناموجود${snapshot.metrics.note ? ` — ${snapshot.metrics.note}` : ""}`,
    newEvents.length
      ? `🔄 رویداد جدید: ${newEvents.slice(0, 5).map((e) => e.type).join("، ")}${newEvents.length > 5 ? "…" : ""}`
      : "🔄 رویداد جدید: ندارد",
  ];

  if (snapshot.limitations.length) {
    lines.push(`⚠️ محدودیت‌ها: ${snapshot.limitations.join("؛ ")}`);
  }

  if (!triggers.length) {
    lines.push("", "✅ وضعیت در محدودهٔ آستانه‌هاست؛ رخدادی ثبت نشد.");
    return lines.join("\n");
  }

  lines.push("", "🚨 آستانه‌های هشدار:");
  for (const trigger of triggers) lines.push(`• ${trigger.detail}`);

  if (cooldown.active) {
    lines.push(
      "",
      `⏳ cooldown فعال است تا ${cooldown.until ? faTime(cooldown.until) : "—"}${
        cooldown.remainingSec ? ` (${cooldown.remainingSec} ثانیه)` : ""
      }؛ هشدار/رخداد تکراری ثبت نمی‌شود.`,
    );
    return lines.join("\n");
  }

  if (!incident) {
    lines.push("", "⚠️ رخداد جدیدی ساخته نشد.");
    return lines.join("\n");
  }

  lines.push("", `🆔 رخداد پایش: ${incident.incidentId}`);
  if (incident.diagnosis) {
    lines.push(incident.diagnosis.text);
  } else {
    lines.push(`❌ تشخیص ناموفق بود${incident.diagnosisError ? `: ${incident.diagnosisError}` : "."}`);
  }

  if (incident.remediation) {
    const label =
      incident.remediation.approval === "pending"
        ? "⏳ اقدام نیازمند تأیید انسانی است"
        : incident.remediation.auto
          ? "🤖 اقدام خودکار طبق سیاست"
          : incident.remediation.executed
            ? "✅ اقدام اجرا شد"
            : "⚠️ اقدام اجرا نشد";
    lines.push("", `${label}:`);
    lines.push(incident.remediation.text);
  } else if (incident.remediationSkippedReason) {
    lines.push("", `ℹ️ ${incident.remediationSkippedReason}`);
  }

  return lines.join("\n");
}

/**
 * یک چرخهٔ کامل پایش. هیچ خواب/تاخیری در این تابع نیست؛
 * حلقهٔ دائمی در `npm run watch` قرار دارد.
 */
export async function runWatchCheck(options: WatchOptions): Promise<WatchCheckResult> {
  const app = options.app.trim();
  if (!isAllowedApp(app)) {
    throw new Error(`اپ «${app}» در لیست مجاز نیست (مجاز: ${config.allowedApps.join("، ")}).`);
  }

  const deps = options.deps ?? {};
  const startedMs = Date.now();
  const nowFn = deps.now ?? (() => new Date());
  const now = nowFn();
  const at = now.toISOString();
  const stateDir = options.stateDir ?? config.stateDir;
  const cooldownSec = options.cooldownSec ?? config.watchCooldownSec;
  const state = loadWatchState(app, stateDir);

  const probeRoute = deps.probeRoute ?? defaultProbeRoute;
  const readMetrics = deps.readMetrics ?? defaultReadMetrics;
  const readEvents = deps.readEvents ?? defaultReadEvents;
  const diagnose = deps.diagnose ?? defaultDiagnose;
  const remediate = deps.remediate ?? defaultRemediate;
  const audit = deps.audit ?? writeAudit;

  const [routes, metrics, eventsResult] = await Promise.all([
    Promise.all(
      WATCH_PATHS.map(async (routePath) => {
        try {
          return routeResult(routePath, await probeRoute(app, routePath));
        } catch (err) {
          return routeResult(routePath, { error: (err as Error).message });
        }
      }),
    ),
    readMetrics(app).catch(
      (): WatchMetricsSummary => ({
        available: false,
        cpu: null,
        memory: null,
        note: "خلاصهٔ متریک در دسترس نبود.",
      }),
    ),
    readEvents(app)
      .then((items) => ({ items, available: true as const }))
      .catch((err: unknown) => ({
        items: [] as EventItem[],
        available: false as const,
        error: (err as Error).message,
      })),
  ]);

  const stats = computeWatchStats(routes);
  const limitations: string[] = [];
  for (const route of routes) {
    if (!route.available) limitations.push(`پروب ${route.path} ناموفق بود.`);
  }
  if (!metrics.available) limitations.push("خلاصهٔ متریک در دسترس نبود.");
  if (!eventsResult.available) limitations.push("دریافت رویدادها ناموفق بود.");

  const firstRun = state.lastEventTsSec === undefined;
  const newEvents = firstRun
    ? []
    : eventsResult.items.filter((event) => {
        const ts = eventTimestampSec(event);
        return ts !== null && ts > (state.lastEventTsSec ?? 0);
      });

  // حتی وقتی رویدادها در دسترس نیستند، watermark قبلی را حفظ می‌کنیم.
  if (eventsResult.available) {
    const newest = newestEventSec(eventsResult.items);
    state.lastEventTsSec = Math.max(
      state.lastEventTsSec ?? 0,
      newest ?? Math.floor(now.getTime() / 1000),
    );
  }

  const snapshot: WatchSnapshot = {
    at,
    routes,
    ...stats,
    metrics,
    events: eventsResult.items,
    eventsAvailable: eventsResult.available,
    ...(eventsResult.available ? {} : { eventNote: eventsResult.error }),
    limitations,
  };

  const triggers = detectWatchTriggers(snapshot, newEvents);
  const currentFingerprint = triggersFingerprint(triggers);
  const rawCooldown = cooldownStatus(state, now, cooldownSec);
  // cooldown فقط هشدار «همان» مشکل را خفه می‌کند؛ یک رخداد متفاوت باید دیده شود.
  const cooldown: WatchCooldown =
    rawCooldown.active &&
    state.lastFingerprint !== undefined &&
    state.lastFingerprint !== currentFingerprint
      ? { active: false }
      : rawCooldown;
  let incident: WatchIncident | null = null;

  if (triggers.length && !cooldown.active) {
    const incidentId = `inc_${randomUUID().slice(0, 8)}`;
    const fingerprint = currentFingerprint;
    const incidentAt = at;
    const cooldownUntil = new Date(now.getTime() + Math.max(0, cooldownSec) * 1000).toISOString();

    // cooldown قبل از تشخیص ذخیره می‌شود تا خطای تشخیص هم باعث هشدار تکراری نشود.
    state.lastIncidentAt = incidentAt;
    state.cooldownUntil = cooldownUntil;
    state.lastIncidentId = incidentId;
    state.lastFingerprint = fingerprint;
    saveWatchState(state, stateDir);

    const symptom = triggers.map((t) => t.detail).join(" ");
    let diagnosis: DiagnosisRun | null = null;
    let diagnosisError: string | undefined;
    try {
      diagnosis = await diagnose(app, symptom);
    } catch (err) {
      diagnosisError = (err as Error).message;
    }

    let remediation: WatchRemediation | null = null;
    let remediationSkippedReason: string | undefined;
    if (options.remediate === false) {
      remediationSkippedReason = "اقدام درمانی با درخواست فراخواننده غیرفعال شده است.";
    } else if (!diagnosis) {
      remediationSkippedReason = "چون تشخیص کامل نشد، هیچ اقدامی روی اپ انجام نشد.";
    } else if (!diagnosis.report.hypotheses.length) {
      remediationSkippedReason = "تشخیص به علت مشخصی نرسید؛ برای جلوگیری از تغییر کورکورانه، اقدامی انجام نشد.";
    } else {
      try {
        remediation = remediationFromOutcome(await remediate(app));
      } catch (err) {
        remediation = {
          kind: "liara_set_env",
          executed: false,
          approval: "error",
          auto: false,
          text: `❌ اقدام درمانی ناموفق بود: ${(err as Error).message}`,
        };
      }
    }

    incident = {
      incidentId,
      at: incidentAt,
      triggers,
      diagnosis,
      ...(diagnosisError ? { diagnosisError } : {}),
      remediation,
      ...(remediationSkippedReason ? { remediationSkippedReason } : {}),
    };

    const approval: AuditApproval = remediation ? remediation.approval : "not-required";
    const auditResult: AuditEntry["result"] =
      diagnosisError || approval === "error"
        ? "error"
        : approval === "rejected"
          ? "rejected"
          : "ok";

    audit({
      ts: at,
      tool: "watch_incident",
      app,
      params: {
        triggers: triggers.map((t) => ({ code: t.code, path: t.path ?? null })),
        rate500Pct: Math.round(snapshot.rate500Pct * 100) / 100,
        maxP50: snapshot.maxP50,
        newEventTypes: newEvents.filter(isRestartEvent).map((e) => e.type),
      },
      approval,
      result: auditResult,
      durationMs: Math.max(0, Date.now() - startedMs),
      detail: `${incidentId}: ${triggers.map((t) => t.code).join("، ")}`,
    });
  }

  state.lastCheckAt = at;
  saveWatchState(state, stateDir);

  const base: Omit<WatchCheckResult, "reportFa"> = {
    app,
    at,
    snapshot,
    triggers,
    newEvents,
    cooldown,
    incident,
  };

  return { ...base, reportFa: formatWatchReport(base) };
}

/** خلاصهٔ کوتاه برای structuredContent ابزار MCP. */
export function watchSummary(result: WatchCheckResult): Record<string, unknown> {
  return {
    ok: true,
    app: result.app,
    at: result.at,
    rate500Pct: Math.round(result.snapshot.rate500Pct * 100) / 100,
    count500: result.snapshot.count500,
    totalSamples: result.snapshot.totalSamples,
    maxP50: result.snapshot.maxP50,
    maxP50Path: result.snapshot.maxP50Path,
    triggers: result.triggers,
    cooldown: result.cooldown,
    incidentId: result.incident?.incidentId,
    diagnosisStatus: result.incident?.diagnosis?.report.status,
    analysisSource: result.incident?.diagnosis
      ? result.incident.diagnosis.llmUsed
        ? "llm"
        : "rules"
      : undefined,
    remediationApproval: result.incident?.remediation?.approval,
    remediationExecuted: result.incident?.remediation?.executed,
    newEventTypes: result.newEvents.map((e) => e.type),
  };
}
