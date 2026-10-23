/**
 * پارامترهای خواندنی که preflight و ابزارهای مشاهده با منبع CLI یا پاسخ زنده می‌فرستند.
 *
 * لاگ v2: @liara/cli@9.6.0 package/lib/commands/app/logs.js:25-28
 * و getStart در :222-225. `start` یونیکس‌ثانیه است، نه رشتهٔ ISO.
 * `last_lines` در CLI بولی است (:278-281).
 *
 * متریک در CLI نیست. `since: 30` از سقف ۷ روز قدیمی‌تر است.
 * timestamp میلی‌ثانیه روی /metrics/cpu پاسخ ۵۰۳ می‌دهد.
 * یونیکس‌ثانیهٔ همان بازه پاسخ ۲۰۰ با کلیدهای end و result می‌دهد.
 */

export interface LogsV2Query {
  start: number;
  direction: "forward";
  last_lines: number | boolean;
  [key: string]: string | number | boolean | undefined;
}

export function logsV2Query(sinceMs: number, lastLines: number | boolean = true): LogsV2Query {
  return {
    start: Math.floor(sinceMs / 1000),
    direction: "forward",
    last_lines: lastLines,
  };
}

export function metricsSince(nowMs: number, windowMs = 30 * 60_000): number {
  return Math.floor((nowMs - windowMs) / 1000);
}
