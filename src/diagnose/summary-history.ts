/**
 * metrics/summary یک نقطهٔ لحظه‌ای برمی‌گرداند.
 * نمونه‌های پشت‌سرهم همین‌جا جمع می‌شوند تا روند بین دو خواندن دیده شود.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { assessSummaryMemory, samplesFromSummary, type SummaryMemory } from "./summary-memory.js";

interface HistoryFile {
  samples: number[];
}

function historyPath(app: string, stateDir: string): string {
  return path.join(stateDir, `summary-memory-${app.replace(/[^a-z0-9-]/gi, "")}.json`);
}

function readSamples(file: string): number[] {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as HistoryFile;
    if (!Array.isArray(parsed.samples)) return [];
    return parsed.samples.filter((value) => typeof value === "number" && Number.isFinite(value));
  } catch {
    return [];
  }
}

/** نمونهٔ تازه را به تاریخچه اضافه می‌کند و روند را روی کل نمونه‌ها حساب می‌کند. */
export function rememberSummary(app: string, raw: unknown, planMB: number | null, stateDir = config.stateDir): SummaryMemory {
  const fresh = samplesFromSummary(raw);
  const latest = fresh.length ? fresh[fresh.length - 1]! : null;
  const file = historyPath(app, stateDir);
  const samples = readSamples(file);
  if (latest !== null && samples[samples.length - 1] !== latest) samples.push(latest);
  const kept = samples.slice(-12);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(file, JSON.stringify({ samples: kept }), "utf8");
  const payload = { memoryUsage: [{ value: kept.map((value, index) => [index, value]) }] };
  return assessSummaryMemory(payload, planMB);
}
