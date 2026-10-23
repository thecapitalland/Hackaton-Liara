/**
 * حافظه از شکل رسمی GET /v1/projects/{name}/metrics/summary.
 * OpenAPI واحد را نگفته است. مقدار تا ۶۵۵۳۶ مگابایت فرض می‌شود
 * (سقف ۶۴ گیگابایت). بزرگ‌تر از آن بایت است، چون نمونهٔ زنده همین شکل را داشت
 * و به‌عنوان مگابایت ناممکن است.
 */

export interface SummaryMemory {
  samples: number[];
  rising: boolean;
  over80: boolean;
  last: number | null;
  planMB: number | null;
  unit: "MB" | "bytes";
  /** خط پایدار برای شاهد Jev. فقط عدد حافظه است. */
  line: string;
}

const MB_CEILING = 65_536;

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/** memoryUsage[].value به شکل [زمان، مقدار] یا آرایهٔ تو در تو. */
export function samplesFromSummary(raw: unknown): number[] {
  const root = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const summary =
    root["summary"] && typeof root["summary"] === "object"
      ? (root["summary"] as Record<string, unknown>)
      : root;
  const usage = summary["memoryUsage"] ?? summary["memory"];
  const out: number[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      const second = node.length >= 2 ? asNumber(node[1]) : null;
      if (asNumber(node[0]) !== null && second !== null && !Array.isArray(node[1])) {
        out.push(second);
        return;
      }
      for (const item of node) visit(item);
      return;
    }
    if (node && typeof node === "object" && "value" in (node as Record<string, unknown>)) {
      visit((node as Record<string, unknown>)["value"]);
    }
  };
  visit(usage);
  return out.filter((value) => value >= 0 && value < 1e15);
}

export function assessSummaryMemory(raw: unknown, planMB: number | null): SummaryMemory {
  const samples = samplesFromSummary(raw);
  const last = samples.length ? samples[samples.length - 1]! : null;
  const previous = samples.length >= 2 ? samples[samples.length - 2]! : null;
  const rising = last !== null && previous !== null && (last > previous || last > samples[0]!);
  const unit: SummaryMemory["unit"] =
    samples.length > 0 && samples.every((value) => value <= MB_CEILING) ? "MB" : "bytes";
  const plan = typeof planMB === "number" && Number.isFinite(planMB) && planMB > 0 ? planMB : null;
  const lastMb = last === null ? null : unit === "MB" ? last : last / (1024 * 1024);
  const over80 = lastMb !== null && plan !== null && lastMb / plan >= 0.8;
  const line = `summary-memory samples=${samples.length} rising=${rising} over80=${over80} last=${last ?? "none"} planMB=${plan ?? "unknown"}`;
  return { samples, rising, over80, last, planMB: plan, unit, line };
}
