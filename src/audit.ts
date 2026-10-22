/**
 * Agate-Liara — لاگ ممیزی (audit log).
 * هر فراخوانی ابزار (خواندنی یا نوشتنی) اینجا ثبت می‌شود.
 * فایل: ./.agate/audit.jsonl (در gitignore است)
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { config, type ApprovalPolicy } from "./config.js";
import { redact } from './redact.js';

export type AuditApproval =
  | "auto"
  /** اجرای خودکار با ذکر سیاست، مثلاً auto:balanced */
  | `auto:${ApprovalPolicy}`
  | "approved"
  | "rejected"
  | "pending"
  | "not-required"
  | "error";

/** نام قبلی برای سازگاری */
export type ApprovalOutcome = AuditApproval;

export interface AuditEntry {
  ts: string;
  tool: string;
  app?: string;
  /** پارامترها با مقادیر حساس ماسک‌شده */
  params?: Record<string, unknown>;
  approval: ApprovalOutcome;
  result: "ok" | "error" | "rejected";
  durationMs: number;
  /** پیام کوتاه نتیجه (بدون اسرار) */
  detail?: string;
}

function ensureStateDir(): string {
  const dir = config.stateDir;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function auditPath(): string {
  return path.join(ensureStateDir(), "audit.jsonl");
}

/** ثبت یک رویداد ممیزی. هیچ‌گاه خطای ثبت، اجرای ابزار را متوقف نمی‌کند. */
export function writeAudit(entry: AuditEntry): void {
  try {
    const line = JSON.stringify(redact(entry));
    appendFileSync(auditPath(), `${line}\n`, "utf8");
  } catch {
    /* ممیزی نباید جریان کار را بشکند */
  }
}

/** خواندن N خط آخر لاگ ممیزی (جدیدترین آخر) */
export function readAuditTail(n = 20): AuditEntry[] {
  const file = auditPath();
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  const slice = lines.slice(-Math.max(1, n));
  const out: AuditEntry[] = [];
  for (const l of slice) {
    try {
      out.push(JSON.parse(l) as AuditEntry);
    } catch {
      /* خط خراب را نادیده بگیر */
    }
  }
  return out;
}

/** ماسک‌کردن عمیق مقادیر حساس پارامترها برای ثبت در ممیزی */
export function maskParams(
  params: Record<string, unknown> | undefined,
  secretKeys: string[] = ["value", "values", "token", "apiKey", "password", "secret", "env"],
): Record<string, unknown> | undefined {
  if (!params) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (secretKeys.includes(k.toLowerCase())) {
      out[k] = Array.isArray(v) ? v.map(() => "••••") : "••••";
    } else if (v && typeof v === "object") {
      out[k] = maskParams(v as Record<string, unknown>, secretKeys);
    } else {
      out[k] = v;
    }
  }
  return out;
}
