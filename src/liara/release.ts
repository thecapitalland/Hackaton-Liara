/**
 * پاسخ GET /v1/releases/{id} وضعیت را تودرتو برمی‌گرداند: `{ release: { state } }`.
 * این helper هر دو شکل تودرتو و مسطح را یکسان می‌کند.
 */
export function unwrapRelease(raw: unknown): Record<string, unknown> {
  const outer = (raw ?? {}) as Record<string, unknown>;
  const inner = outer["release"];
  return inner && typeof inner === "object" ? (inner as Record<string, unknown>) : outer;
}
