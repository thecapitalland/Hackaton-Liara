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
 * gitignored است و هرگز داخل گزارش/LLM نمی‌رود. برای تغییراتی که خارج از این
 * سرور انجام شده‌اند، audit/release فقط «وقوع تغییر» را نشان می‌دهند؛ در این
 * حالت rollback دقیق ممکن نیست و فراخواننده باید به restart برگردد.
 */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import type { AuditEntry } from "./audit.js";
import { readAuditEntries } from "./audit.js";
import { liaraGet } from "./liara/client.js";
import { EP } from "./liara/endpoints.js";

/** بازهٔ پیش‌فرض جست‌وجوی تغییر env قبل از رخداد: ۱۰ دقیقه. */
export const ENV_CHANGE_WINDOW_SEC = 10 * 60;
const MAX_HISTORY_RECORDS = 100;

export type EnvChangeKind = "set_env" | "rollback";
export type EnvChangeSource = "journal" | "audit" | "release";

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
  /** برای journal مقدار قبل/بعد کامل است؛ برای audit/release فقط متادیتا. */
  revertable: boolean;
  changes: EnvChangeValue[];
  keys: string[];
  auditTs?: string;
  releaseId?: string;
  releaseType?: string;
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

/**
 * آخرین تغییر env قبل از `beforeAt` را پیدا می‌کند.
 * - journal: مقدار قبل/بعد دارد و revertable=true.
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
    let raw: unknown = options.releases;
    if (raw === undefined) {
      try {
        const res = await liaraGet<unknown>(EP.listReleases(app));
        raw = res.data;
      } catch {
        raw = null;
      }
    }
    const release = releaseRows(raw)
      .filter((row) => /ENV[_-]?UPDATE|UPDATE[_-]?ENV/i.test(String(row["type"] ?? row["action"] ?? "")))
      .filter((row) => inWindow(String(row["createdAt"] ?? row["created_at"] ?? ""), beforeMs, windowSec))
      .sort(
        (a, b) =>
          timestampMs(String(b["createdAt"] ?? b["created_at"] ?? ""))! -
          timestampMs(String(a["createdAt"] ?? a["created_at"] ?? ""))!,
      )[0];
    if (release) {
      const at = String(release["createdAt"] ?? release["created_at"] ?? "");
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

  if (!candidates.length) return null;
  const sourceRank: Record<EnvChangeSource, number> = { journal: 3, audit: 2, release: 1 };
  candidates.sort((a, b) => {
    const diff = timestampMs(b.at)! - timestampMs(a.at)!;
    return diff !== 0 ? diff : sourceRank[b.source] - sourceRank[a.source];
  });
  return candidates[0] ?? null;
}
