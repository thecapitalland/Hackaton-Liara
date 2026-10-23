import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export function connectionDigest(): string {
  return createHash('sha256').update(JSON.stringify([config.apiBase,config.dnsBase,config.teamId,config.token])).digest('hex');
}

export type PreflightGateReason = "ready" | "missing" | "unreadable" | "connection" | "not_ready" | "expired";

export interface PreflightGateStatus {
  ok: boolean;
  reason: PreflightGateReason;
  ranAt?: string;
}

const DAY_MS = 24 * 60 * 60_000;

/** رسید را بدون پرتاب خطا می‌خواند. نوشتن‌ها هنوز از assertPreflight رد می‌شوند. */
export function readPreflightGate(now = Date.now(), stateDir = config.stateDir): PreflightGateStatus {
  const file = path.join(stateDir, "preflight-gate.json");
  if (!existsSync(file)) return { ok: false, reason: "missing" };
  try {
    const receipt = JSON.parse(readFileSync(file, "utf8")) as {
      connection?: unknown;
      ready?: unknown;
      ranAt?: unknown;
    };
    const ranAt = typeof receipt.ranAt === "string" ? receipt.ranAt : undefined;
    if (receipt.connection !== connectionDigest()) return { ok: false, reason: "connection", ranAt };
    if (receipt.ready !== true) return { ok: false, reason: "not_ready", ranAt };
    if (!(now - Date.parse(ranAt ?? "") < DAY_MS)) return { ok: false, reason: "expired", ranAt };
    return { ok: true, reason: "ready", ranAt };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

/** No provider mutation before a successful authenticated read-only preflight. */
export function assertPreflight(): void {
  if (readPreflightGate().ok) return;
  throw new Error('❌ ابتدا npm run preflight را با همین حساب و تیم اجرا و اختلاف‌های API را بررسی کنید؛ هیچ تغییری اعمال نشد.');
}
