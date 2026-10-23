/**
 * Agate-Liara — تاریخچهٔ محلی تغییرات env برای rollback دقیق.
 *
 * چرا فایل جدا؟
 *  - `audit.jsonl` مقادیر env را عمداً ماسک می‌کند و برای بازگردانی دقیق
 *    «مقدار قبلی» کافی نیست.
 *  - API لیارا فقط env فعلی و releaseهای `ENV_UPDATE` را می‌دهد؛ مقادیر
 *    قبلی را برنمی‌گرداند.
 *
 * بنابراین هر تغییر env که از این سرور عبور کند، قبل/بعدِ فقط کلیدهای تغییریافته
 * در `.agate/env-history-<app>.json` با مجوز 0600 ثبت می‌شود. خود فایل
 * gitignored است و هرگز داخل گزارش/LLM نمی‌رود.
 *
 * برای تغییرات خارج از این سرور، audit/release فقط «وقوع تغییر» را نشان می‌دهند.
 * راه سوم، snapshot سالم env است: هر بار diagnose/watch اپ را سالم می‌بیند، env
 * فعلی با مجوز 0600 در `.agate/env-baseline-<app>.json` ذخیره می‌شود. diff این
 * snapshot با env فعلی فقط در مرحلهٔ remediation استفاده می‌شود، نه در استدلال
 * تشخیص و نه در ورودی LLM.
 */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import type { AuditEntry } from "./audit.js";
import { readAuditEntries } from "./audit.js";
import { liaraGet } from "./liara/client.js";
import { EP } from "./liara/endpoints.js";
import type { ProbeResult } from "./types.js";

/** بازهٔ پیش‌فرض جست‌وجوی تغییر env قبل از رخداد: ۱۰ دقیقه. */
export const ENV_CHANGE_WINDOW_SEC = 10 * 60;
/** p50 بالاتر از این مقدار «عادی» نیست و baseline سالم ثبت نمی‌شود. */
export const BASELINE_MAX_P50_MS = 1500;
const MAX_HISTORY_RECORDS = 100;

export type EnvChangeKind = "set_env" | "rollback";
export type EnvChangeSource = "journal" | "baseline" | "audit" | "release";

export interface EnvVar {
  key: string;
  value: string;
}

export interface EnvChangeValue {
  key: string;
  /** null یعنی کلید قبل از تغییر وجود نداشت. */
  before: string | null;
  after: string | null;
}

export interface EnvDiffSummary {
  added: string[];
  removed: string[];
  changed: string[];
}

/** snapshot کامل env در یک لحظهٔ سالم. مقادیر فقط محلی و 0600 هستند. */
export interface EnvBaseline {
  app: string;
  capturedAt: string;
  env: EnvVar[];
}

export interface EnvBaselineOptions {
  stateDir?: string;
  at?: string;
}

export interface BaselineRollbackInfo {
  baselineAt: string;
  releaseAt: string;
  releaseId: string;
  releaseType: string;
}

export interface EnvHistoryRecord {
  id: string;
  at: string;
  app: string;
  kind: EnvChangeKind;
  changes: EnvChangeValue[];
}

export interface EnvChangeCandidate {
  id: string;
  at: string;
  app: string;
  source: EnvChangeSource;
  /**
   * برای journal و baseline مقدار قبل/بعد کامل است؛ برای audit/release فقط
   * متادیتا. baseline فقط در مرحلهٔ remediation محاسبه می‌شود.
   */
  revertable: boolean;
  changes: EnvChangeValue[];
  keys: string[];
  /** خلاصهٔ کلیدها برای نمایش بدون مقدار. */
  diff?: EnvDiffSummary;
  auditTs?: string;
  releaseId?: string;
  releaseType?: string;
  baselineAt?: string;
}

export interface FindEnvChangeOptions {
  stateDir?: string;
  /** بازهٔ جست‌وجو قبل از incidentAt؛ پیش‌فرض ۱۰ دقیقه. */
  windowSec?: number;
  /** در production پیش‌فرض true؛ برای تست می‌توان false داد. */
  includeReleases?: boolean;
  /** برای تست deterministic؛ در غیر این صورت audit.jsonl خوانده می‌شود. */
  auditEntries?: AuditEntry[];
  /** برای تست deterministic؛ در غیر این صورت releaseهای Liara خوانده می‌شوند. */
  releases?: unknown;
  /**
   * آیا snapshot سالم env هم به‌عنوان منبع مقایسه شود؟ پیش‌فرض false است تا
   * diagnose هیچ‌گاه diff/env را محاسبه نکند. فقط remediation آن را true می‌کند.
   */
  includeBaseline?: boolean;
  /** برای تست deterministic؛ در غیر این صورت env فعلی از API خوانده می‌شود. */
  currentEnvs?: EnvVar[];
  /** برای تست deterministic؛ null یعنی baseline را از فایل نخوان. */
  baseline?: EnvBaseline | null;
}

function assertAppName(app: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(app)) throw new Error("نام اپ نامعتبر است.");
}

function stateDirOf(options: FindEnvChangeOptions = {}): string {
  return options.stateDir ?? config.stateDir;
}

export function envHistoryPath(app: string, stateDir = config.stateDir): string {
  assertAppName(app);
  mkdirSync(stateDir, { recursive: true });
  return path.join(stateDir, `env-history-${app}.json`);
}

export function envBaselinePath(app: string, stateDir = config.stateDir): string {
  assertAppName(app);
  mkdirSync(stateDir, { recursive: true });
  return path.join(stateDir, `env-baseline-${app}.json`);
}

/** خواندن env فعلی از API لیارا. مقادیر فقط در حافظه/فایل محلی می‌مانند. */
export async function getProjectEnvs(app: string): Promise<EnvVar[]> {
  const { data } = await liaraGet<Record<string, unknown>>(EP.getProject(app));
  const project = (data?.project ?? data) as Record<string, unknown>;
  const envs = project["envs"];
  if (!Array.isArray(envs)) {
    throw new Error(
      "ساختار envs شناخته نشد؛ برای جلوگیری از حذف متغیرها عملیات متوقف شد.",
    );
  }
  return envs.map((entry) => {
    if (entry && typeof entry === "object") {
      const row = entry as Record<string, unknown>;
      return { key: String(row["key"] ?? ""), value: String(row["value"] ?? "") };
    }
    return { key: String(entry), value: "" };
  });
}

/**
 * ذخیرهٔ snapshot سالم env. فایل gitignored، mode=0600 و هرگز برای LLM/خروجی
 * عمومی فرستاده نمی‌شود؛ خروجی ابزارها فقط مقادیر ماسک‌شده را نشان می‌دهد.
 */
export function saveEnvBaseline(
  app: string,
  env: EnvVar[],
  options: EnvBaselineOptions = {},
): EnvBaseline {
  const baseline: EnvBaseline = {
    app,
    capturedAt: options.at ?? new Date().toISOString(),
    env: [...env]
      .map((row) => ({ key: row.key, value: row.value }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  };
  const file = envBaselinePath(app, options.stateDir);
  writeFileSync(file, JSON.stringify(baseline, null, 2), { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows ممکن است mode را نادیده بگیرد */
  }
  return baseline;
}

export function loadEnvBaseline(
  app: string,
  stateDir = config.stateDir,
): EnvBaseline | null {
  const file = envBaselinePath(app, stateDir);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<EnvBaseline>;
    if (
      parsed.app !== app ||
      typeof parsed.capturedAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.capturedAt)) ||
      !Array.isArray(parsed.env)
    ) {
      return null;
    }
    const env = parsed.env.filter(
      (row): row is EnvVar =>
        Boolean(row) &&
        typeof row === "object" &&
        typeof (row as EnvVar).key === "string" &&
        typeof (row as EnvVar).value === "string",
    );
    if (env.length !== parsed.env.length) return null;
    return { app, capturedAt: parsed.capturedAt, env };
  } catch {
    return null;
  }
}

export function hasEnvBaseline(app: string, stateDir = config.stateDir): boolean {
  return loadEnvBaseline(app, stateDir) !== null;
}

/** آیا پروب واقعاً سالم است؟ ۰ خطای ۵۰۰/۵xx و p50 در محدودهٔ عادی. */
export function isHealthyProbe(
  probe: ProbeResult | { error: string },
): probe is ProbeResult {
  if ("error" in probe) return false;
  if (!probe.samples.length) return false;
  if (probe.samples.some((sample) => sample.status === 500)) return false;
  if (
    probe.samples.some(
      (sample) =>
        sample.status === null || sample.status < 200 || sample.status >= 300,
    )
  ) {
    return false;
  }
  return probe.p50 !== null && probe.p50 <= BASELINE_MAX_P50_MS;
}

/** خواندن env و ثبت baseline؛ فقط وقتی پروب سالم است. */
export async function captureHealthyEnvBaseline(
  app: string,
  probe: ProbeResult | { error: string },
  options: EnvBaselineOptions = {},
): Promise<EnvBaseline | null> {
  if (!isHealthyProbe(probe)) return null;
  const env = await getProjectEnvs(app);
  return saveEnvBaseline(app, env, options);
}

/** ثبت baseline از env فعلی؛ برای watch که خودش سلامت را سنجیده است. */
export async function captureEnvBaseline(
  app: string,
  options: EnvBaselineOptions = {},
): Promise<EnvBaseline> {
  const env = await getProjectEnvs(app);
  return saveEnvBaseline(app, env, options);
}

export function loadEnvHistory(app: string, stateDir = config.stateDir): EnvHistoryRecord[] {
  const file = envHistoryPath(app, stateDir);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    const rows = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { records?: unknown }).records)
        ? ((parsed as { records: unknown[] }).records)
        : [];
    return rows.filter((row): row is EnvHistoryRecord => {
      if (!row || typeof row !== "object") return false;
      const r = row as Partial<EnvHistoryRecord>;
      const validKind = r.kind === undefined || r.kind === "set_env" || r.kind === "rollback";
      const validChanges =
        Array.isArray(r.changes) &&
        r.changes.every(
          (change) =>
            Boolean(change) &&
            typeof change === "object" &&
            typeof change.key === "string" &&
            (change.before === null || typeof change.before === "string") &&
            (change.after === null || typeof change.after === "string"),
        );
      return (
        typeof r.id === "string" &&
        typeof r.at === "string" &&
        typeof r.app === "string" &&
        validKind &&
        validChanges
      );
    });
  } catch {
    return [];
  }
}

function normalize(rows: EnvVar[]): Map<string, string> {
  return new Map(rows.map((row) => [row.key, row.value]));
}

/** فقط کلیدهایی که واقعاً تغییر کرده‌اند؛ مقادیر خالی هم معتبرند. */
export function diffEnv(
  before: EnvVar[],
  after: EnvVar[],
): EnvChangeValue[] {
  const oldMap = normalize(before);
  const newMap = normalize(after);
  const keys = [...new Set([...oldMap.keys(), ...newMap.keys()])].sort();
  const changes: EnvChangeValue[] = [];
  for (const key of keys) {
    const oldValue = oldMap.has(key) ? oldMap.get(key)! : null;
    const newValue = newMap.has(key) ? newMap.get(key)! : null;
    if (oldValue !== newValue) changes.push({ key, before: oldValue, after: newValue });
  }
  return changes;
}

/** خلاصهٔ کلیدها؛ هیچ مقداری در آن نیست. */
export function envDiffSummary(changes: EnvChangeValue[]): EnvDiffSummary {
  const summary: EnvDiffSummary = { added: [], removed: [], changed: [] };
  for (const change of changes) {
    if (change.before === null) summary.added.push(change.key);
    else if (change.after === null) summary.removed.push(change.key);
    else summary.changed.push(change.key);
  }
  return summary;
}

/**
 * ثبت یک تغییر env. اگر تغییری وجود نداشته باشد null برمی‌گرداند.
 * فایل با mode 0600 نوشته می‌شود؛ روی Windows این mode محدودیت کامل نیست
 * ولی فایل در پوشهٔ gitignored `.agate` می‌ماند.
 */
export function recordEnvChange(
  app: string,
  before: EnvVar[],
  after: EnvVar[],
  meta: { at?: string; kind?: EnvChangeKind; stateDir?: string } = {},
): EnvHistoryRecord | null {
  const changes = diffEnv(before, after);
  if (!changes.length) return null;

  const record: EnvHistoryRecord = {
    id: `env_${randomUUID().slice(0, 8)}`,
    at: meta.at ?? new Date().toISOString(),
    app,
    kind: meta.kind ?? "set_env",
    changes,
  };

  const records = [...loadEnvHistory(app, meta.stateDir), record].slice(-MAX_HISTORY_RECORDS);
  const file = envHistoryPath(app, meta.stateDir);
  writeFileSync(file, JSON.stringify(records, null, 2), { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows ممکن است mode را نادیده بگیرد */
  }
  return record;
}

function timestampMs(raw: string | null | undefined): number | null {
  const text = raw?.trim();
  if (!text) return null;
  const numeric = Number(text);
  if (Number.isFinite(numeric)) {
    return Math.floor(numeric > 1e12 ? numeric : numeric * 1000);
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function inWindow(at: string, beforeMs: number, windowSec: number): boolean {
  const ms = timestampMs(at);
  if (ms === null) return false;
  return ms <= beforeMs && ms >= beforeMs - Math.max(0, windowSec) * 1000;
}

function releaseRows(raw: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { releases?: unknown[] }).releases)
      ? (raw as { releases: unknown[] }).releases
      : [];
  return rows.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object"));
}

function auditEnvKeys(entry: AuditEntry): string[] {
  const params = entry.params ?? {};
  const varsRaw = params["variables"];
  const vars = Array.isArray(varsRaw)
    ? varsRaw
    : varsRaw && typeof varsRaw === "object"
      ? Object.values(varsRaw as Record<string, unknown>)
      : [];
  const unset = Array.isArray(params["unset"])
    ? params["unset"]
    : params["unset"] && typeof params["unset"] === "object"
      ? Object.values(params["unset"] as Record<string, unknown>)
      : [];
  const keys = vars
    .map((v) => (v && typeof v === "object" ? String((v as Record<string, unknown>)["key"] ?? "") : ""))
    .filter(Boolean);
  for (const key of unset) {
    if (typeof key === "string" && key) keys.push(key);
  }
  return [...new Set(keys)].sort();
}

function isEnvUpdateRelease(row: Record<string, unknown>): boolean {
  return /ENV[_-]?UPDATE|UPDATE[_-]?ENV/i.test(
    String(row["type"] ?? row["action"] ?? ""),
  );
}

function releaseCreatedAt(row: Record<string, unknown>): string {
  return String(row["createdAt"] ?? row["created_at"] ?? "");
}

async function loadReleaseRows(
  app: string,
  options: FindEnvChangeOptions,
): Promise<Record<string, unknown>[]> {
  let raw: unknown = options.releases;
  if (raw === undefined) {
    try {
      const res = await liaraGet<unknown>(EP.listReleases(app));
      raw = res.data;
    } catch {
      raw = null;
    }
  }
  return releaseRows(raw);
}

function latestEnvUpdateBetween(
  releases: Record<string, unknown>[],
  afterMs: number,
  beforeMs: number,
): Record<string, unknown> | null {
  return (
    releases
      .filter(isEnvUpdateRelease)
      .filter((row) => {
        const ms = timestampMs(releaseCreatedAt(row));
        return ms !== null && ms >= afterMs && ms <= beforeMs;
      })
      .sort((a, b) => timestampMs(releaseCreatedAt(b))! - timestampMs(releaseCreatedAt(a))!)[0] ??
    null
  );
}

/**
 * فقط متادیتای وجود یک ENV_UPDATE بعد از baseline سالم را برمی‌گرداند.
 * هیچ کلید/مقداری خوانده یا برگردانده نمی‌شود؛ برای انتخاب راهکار در diagnose.
 */
export async function findBaselineRollbackInfo(
  app: string,
  beforeAt: string | Date,
  options: FindEnvChangeOptions = {},
): Promise<BaselineRollbackInfo | null> {
  assertAppName(app);
  const beforeMs = beforeAt instanceof Date ? beforeAt.getTime() : timestampMs(beforeAt);
  if (beforeMs === null || !Number.isFinite(beforeMs)) {
    throw new Error("زمان شروع رخداد نامعتبر است.");
  }
  const baseline =
    options.baseline !== undefined
      ? options.baseline
      : loadEnvBaseline(app, stateDirOf(options));
  if (!baseline) return null;
  const baselineMs = timestampMs(baseline.capturedAt);
  if (baselineMs === null || baselineMs > beforeMs) return null;
  if (options.includeReleases === false) return null;

  const releases = await loadReleaseRows(app, options);
  const release = latestEnvUpdateBetween(releases, baselineMs, beforeMs);
  if (!release) return null;
  const at = releaseCreatedAt(release);
  return {
    baselineAt: baseline.capturedAt,
    releaseAt: at,
    releaseId: String(release["_id"] ?? release["id"] ?? ""),
    releaseType: String(release["type"] ?? ""),
  };
}

/**
 * آخرین تغییر env قبل از `beforeAt` را پیدا می‌کند.
 * - journal: مقدار قبل/بعد دارد و revertable=true.
 * - baseline (فقط با includeBaseline=true): diff با snapshot سالم، revertable=true.
 * - audit / release: فقط وقوع/کلیدها را نشان می‌دهد و revertable=false.
 * تغییرات خود rollback (kind=rollback) کاندید بازگردانی نیستند تا حلقه نسازند.
 */
export async function findLatestEnvChange(
  app: string,
  beforeAt: string | Date,
  options: FindEnvChangeOptions = {},
): Promise<EnvChangeCandidate | null> {
  assertAppName(app);
  const beforeMs = beforeAt instanceof Date ? beforeAt.getTime() : timestampMs(beforeAt);
  if (beforeMs === null || !Number.isFinite(beforeMs)) throw new Error("زمان شروع رخداد نامعتبر است.");
  const windowSec = options.windowSec ?? ENV_CHANGE_WINDOW_SEC;

  const candidates: EnvChangeCandidate[] = [];

  const journalRows = loadEnvHistory(app, stateDirOf(options))
    .filter((record) => record.app === app && inWindow(record.at, beforeMs, windowSec))
    .sort((a, b) => timestampMs(b.at)! - timestampMs(a.at)!);
  const journal = journalRows[0];
  const journalIsRevertable = Boolean(
    journal &&
      (journal.kind ?? "set_env") !== "rollback" &&
      journal.changes.length > 0,
  );
  // اگر آخرین رکورد journal خودِ rollback باشد، تغییر قبل از آن قبلاً برگشته
  // و نباید دوباره کاندید شود. این از حلقهٔ rollback→rollback جلوگیری می‌کند.
  if (journal && journalIsRevertable) {
    candidates.push({
      id: journal.id,
      at: journal.at,
      app,
      source: "journal",
      revertable: true,
      changes: journal.changes,
      keys: journal.changes.map((c) => c.key),
      diff: envDiffSummary(journal.changes),
    });
  }

  const auditEntries = options.auditEntries ?? readAuditEntries();
  const auditChange = auditEntries
    .filter((entry) => entry.tool === "liara_set_env")
    .filter((entry) => entry.app === app)
    .filter((entry) => entry.result === "ok" && entry.approval !== "pending" && entry.approval !== "rejected")
    .filter((entry) => inWindow(entry.ts, beforeMs, windowSec))
    .sort((a, b) => timestampMs(b.ts)! - timestampMs(a.ts)!)[0];
  if (auditChange) {
    const auditMs = timestampMs(auditChange.ts);
    const auditKeys = auditEnvKeys(auditChange);
    const journalKeys = journal?.changes.map((change) => change.key).sort() ?? [];
    const journalKeysCovered =
      journalKeys.length > 0 &&
      journalKeys.every((key) => auditKeys.includes(key));
    // audit یک فراخوانی liara_set_env ممکن است کلیدهای بدون تغییر را هم داشته
    // باشد؛ بنابراین کلیدهای واقعی journal باید زیرمجموعهٔ کلیدهای audit باشند.
    const sameKeys = journalKeysCovered;
    // audit همان تغییر journal است فقط اگر زمان و کلیدها هم‌خوان باشند؛
    // یک تغییر دستی جدیدتر نباید با حدس زمانی خفه شود.
    const sameAsJournal =
      journalIsRevertable &&
      Boolean(journal && auditMs !== null) &&
      sameKeys &&
      Math.abs(timestampMs(journal!.at)! - auditMs!) <= 60_000;
    if (!sameAsJournal) {
      candidates.push({
        id: `audit_${createHash("sha1").update(`${app}:${auditChange.ts}`).digest("hex").slice(0, 10)}`,
        at: auditChange.ts,
        app,
        source: "audit",
        revertable: false,
        changes: [],
        keys: auditKeys,
        auditTs: auditChange.ts,
      });
    }
  }

  if (options.includeReleases !== false) {
    const releases = await loadReleaseRows(app, options);
    const release = releases
      .filter(isEnvUpdateRelease)
      .filter((row) => inWindow(releaseCreatedAt(row), beforeMs, windowSec))
      .sort(
        (a, b) =>
          timestampMs(releaseCreatedAt(b))! - timestampMs(releaseCreatedAt(a))!,
      )[0];
    if (release) {
      const at = releaseCreatedAt(release);
      const releaseMs = timestampMs(at);
      const sameAsJournal =
        journalIsRevertable &&
        Boolean(journal && releaseMs !== null) &&
        Math.abs(timestampMs(journal!.at)! - releaseMs!) <= 60_000;
      if (!sameAsJournal) {
        candidates.push({
          id: `release_${String(release["_id"] ?? release["id"] ?? createHash("sha1").update(at).digest("hex").slice(0, 10))}`,
          at,
          app,
          source: "release",
          revertable: false,
          changes: [],
          keys: [],
          releaseId: String(release["_id"] ?? release["id"] ?? ""),
          releaseType: String(release["type"] ?? ""),
        });
      }
    }
  }

  /*
   * منبع سوم: snapshot سالم env + ENV_UPDATE بعد از آن. این بخش فقط وقتی
   * فعال می‌شود که فراخوانندهٔ remediation صریحاً includeBaseline=true بدهد؛
   * diagnose هرگز این diff را محاسبه یا به LLM نمی‌دهد.
   */
  if (options.includeBaseline) {
    const baseline =
      options.baseline !== undefined
        ? options.baseline
        : loadEnvBaseline(app, stateDirOf(options));
    const baselineMs = baseline ? timestampMs(baseline.capturedAt) : null;
    if (baseline && baselineMs !== null && baselineMs <= beforeMs) {
      const releases = await loadReleaseRows(app, options);
      const release = latestEnvUpdateBetween(releases, baselineMs, beforeMs);
      if (release) {
        const current = options.currentEnvs ?? (await getProjectEnvs(app));
        const changes = diffEnv(baseline.env, current);
        if (changes.length) {
          const at = releaseCreatedAt(release);
          const releaseId = String(release["_id"] ?? release["id"] ?? "");
          candidates.push({
            id: `baseline_${releaseId || createHash("sha1").update(at).digest("hex").slice(0, 10)}`,
            at,
            app,
            source: "baseline",
            revertable: true,
            changes,
            keys: changes.map((change) => change.key),
            diff: envDiffSummary(changes),
            releaseId,
            releaseType: String(release["type"] ?? ""),
            baselineAt: baseline.capturedAt,
          });
        }
      }
    }
  }

  if (!candidates.length) return null;
  const sourceRank: Record<EnvChangeSource, number> = {
    journal: 4,
    baseline: 3,
    audit: 2,
    release: 1,
  };
  candidates.sort((a, b) => {
    const diff = timestampMs(b.at)! - timestampMs(a.at)!;
    return diff !== 0 ? diff : sourceRank[b.source] - sourceRank[a.source];
  });
  return candidates[0] ?? null;
}
