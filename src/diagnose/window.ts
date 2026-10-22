/**
 * Agate-Liara — پنجرهٔ زمانی شواهد.
 *
 * تشخیص فقط باید رویدادهای همان بازهٔ رخداد را ببیند. رویدادهای قدیمی‌تر
 * (یا بدون timestamp قابل‌اتکا) کنار گذاشته می‌شوند تا شواهد گمراه‌کننده
 * مثل چرخهٔ release چند ساعت قبل، تحلیل را منحرف نکند.
 */
import type { EventItem, LogLine } from "../types.js";

/** بازهٔ پیش‌فرض شواهد/رخداد: ۱۰ دقیقه */
export const DEFAULT_EVIDENCE_WINDOW_MINUTES = 10;

/** یک timestamp ثانیه‌ای/میلی‌ثانیه‌ای/ISO را به میلی‌ثانیه تبدیل می‌کند. */
export function timestampMs(raw: string | null | undefined): number | null {
  const text = raw?.trim();
  if (!text) return null;

  const numeric = Number(text);
  if (Number.isFinite(numeric)) {
    // بعضی APIها epoch ثانیه و بعضی میلی‌ثانیه برمی‌گردانند.
    return Math.floor(numeric > 1e12 ? numeric : numeric * 1000);
  }

  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface EvidenceWindowResult<T> {
  items: T[];
  dropped: number;
  /** تعداد آیتم‌هایی که timestamp قابل‌خواندن نداشتند (زیرمجموعهٔ dropped) */
  undated: number;
}

/**
 * رویدادهای داخل بازهٔ [now - windowMinutes, now + skewMs] را نگه می‌دارد.
 * رویداد بدون زمان یا خارج از بازه کنار گذاشته می‌شود.
 */
export function filterEventsToWindow(
  events: EventItem[],
  nowIso: string,
  windowMinutes = DEFAULT_EVIDENCE_WINDOW_MINUTES,
  skewMs = 60_000,
): EvidenceWindowResult<EventItem> {
  const nowMs = timestampMs(nowIso) ?? Date.now();
  const cutoffMs = nowMs - Math.max(0, windowMinutes) * 60_000;
  const upperMs = nowMs + Math.max(0, skewMs);
  const items: EventItem[] = [];
  let dropped = 0;
  let undated = 0;

  for (const event of events) {
    const ts = timestampMs(event.ts);
    if (ts === null) {
      dropped += 1;
      undated += 1;
      continue;
    }
    if (ts < cutoffMs || ts > upperMs) {
      dropped += 1;
      continue;
    }
    items.push(event);
  }

  return { items, dropped, undated };
}

/**
 * لاگ‌هایی که timestamp دارند و خارج از بازه‌اند حذف می‌شوند.
 * لاگ بدون timestamp حفظ می‌شود، چون درخواست لاگ از قبل با `start` محدود شده
 * و حذف آن می‌تواند همهٔ شواهد لاگ را بی‌دلیل پاک کند.
 */
export function filterLogsToWindow(
  logs: LogLine[],
  nowIso: string,
  windowMinutes = DEFAULT_EVIDENCE_WINDOW_MINUTES,
  skewMs = 60_000,
): EvidenceWindowResult<LogLine> {
  const nowMs = timestampMs(nowIso) ?? Date.now();
  const cutoffMs = nowMs - Math.max(0, windowMinutes) * 60_000;
  const upperMs = nowMs + Math.max(0, skewMs);
  const items: LogLine[] = [];
  let dropped = 0;

  for (const log of logs) {
    const ts = timestampMs(log.ts);
    if (ts === null) {
      items.push(log);
      continue;
    }
    if (ts < cutoffMs || ts > upperMs) {
      dropped += 1;
      continue;
    }
    items.push(log);
  }

  return { items, dropped, undated: 0 };
}
