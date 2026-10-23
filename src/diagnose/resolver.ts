/**
 * اتصال LLM فقط با نام میزبان و resolver سیستم.
 * اگر پاسخ loopback باشد درخواست ارسال نمی‌شود و IP دستی جایگزین نمی‌شود.
 */
import { lookup } from "node:dns/promises";

export function isLoopbackAddress(address: string): boolean {
  const raw = address.trim().toLowerCase();
  const value = raw.startsWith("::ffff:") ? raw.slice("::ffff:".length) : raw;
  if (value === "::1" || value === "0:0:0:0:0:0:0:1") return true;
  if (raw.startsWith("fd00:") || value.startsWith("fd00:")) return true;
  return value.startsWith("127.");
}

export async function assertPublicHostname(baseUrl: string): Promise<void> {
  const host = new URL(baseUrl).hostname;
  if (!host) throw new Error("میزبان LLM نامعتبر است.");
  const rows = await lookup(host, { all: true });
  const addresses = rows.map((row) => row.address);
  if (!addresses.length || addresses.some(isLoopbackAddress)) {
    throw new Error(`resolver سیستم برای ${host} به آدرس loopback رسید؛ IP دستی استفاده نشد.`);
  }
}
