/**
 * Agate-Liara — کمک‌کننده‌های مشترک ابزارها.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { maskParams, writeAudit, type AuditApproval } from "../audit.js";
import { faErrorMessage, LiaraError } from "../liara/client.js";
import { redact } from '../redact.js';

/** ساخت پاسخ متنی + ساخت‌یافته */
export function result(
  text: string,
  structured?: Record<string, unknown>,
): CallToolResult {
  const res: CallToolResult = { content: [{ type: "text", text: redact(text) }] };
  if (structured) res.structuredContent = redact(structured);
  return res;
}

/** ساخت پاسخ خطا */
export function errorResult(message: string, code = "ERROR", structured?: Record<string, unknown>): CallToolResult {
  return { ...result(message, { ok: false, code, ...(structured ?? {}) }), isError: true };
}

/** اجرای یک ابزار با ثبت ممیزی و مدیریت خطا */
export async function audited(
  tool: string,
  app: string | undefined,
  params: Record<string, unknown> | undefined,
  fn: () => Promise<CallToolResult>,
  approval: AuditApproval = "auto",
): Promise<CallToolResult> {
  const started = Date.now();
  try {
    const res = await fn();
    const failed = res.isError === true || res.structuredContent?.ok === false;
    const code = res.structuredContent?.code;
    const autoPolicy = res.structuredContent?.approvalMode === 'automatic'
      ? res.structuredContent?.approvalPolicy
      : undefined;
    const autoOutcome = autoPolicy === 'strict' || autoPolicy === 'balanced' || autoPolicy === 'auto'
      ? (`auto:${autoPolicy}` as AuditApproval)
      : undefined;
    const outcome = code === 'REJECTED' ? 'rejected' : code === 'APPROVAL_REQUIRED' ? 'pending' : res.structuredContent?.approval === 'approved' ? 'approved' : autoOutcome ?? approval;
    writeAudit({
      ts: new Date().toISOString(),
      tool,
      app,
      params: maskParams(params),
      approval: outcome === 'pending' || outcome === 'rejected' ? outcome : failed ? 'error' : outcome,
      result: outcome === 'rejected' ? 'rejected' : failed ? 'error' : 'ok',
      durationMs: Date.now() - started,
      detail: firstText(res),
    });
    return res;
  } catch (err) {
    const message = faErrorMessage(err);
    writeAudit({
      ts: new Date().toISOString(),
      tool,
      app,
      params: maskParams(params),
      approval: "error",
      result: "error",
      durationMs: Date.now() - started,
      detail: message,
    });
    return err instanceof LiaraError
      ? errorResult(message, err.code, { status: err.status ?? null, providerResponse: err.details ?? null })
      : errorResult(message);
  }
}

/** اولین بلوک متنی پاسخ */
export function firstText(res: CallToolResult): string {
  const first = res.content?.[0];
  if (first && first.type === "text") return first.text.slice(0, 400);
  return "";
}

/** جداکنندهٔ متنی */
export function bullets(lines: string[]): string {
  return lines.map((l) => `• ${l}`).join("\n");
}

/** قالب‌بندی زمان ISO به فارسی */
export function faTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("fa-IR", { dateStyle: "short", timeStyle: "short" });
}
