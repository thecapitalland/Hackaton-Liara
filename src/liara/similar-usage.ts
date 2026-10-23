import { assessSummaryMemory } from "../diagnose/summary-memory.js";
import { liaraGet } from "./client.js";
import { EP } from "./endpoints.js";

export interface SimilarUsage {
  memoryGB: number | null;
  cpuCores: number | null;
  similarApp: string | null;
  usageNote: string;
}

interface ListedProject {
  name: string;
  type: string;
  createdAt: string;
}

/**
 * اپ مشابه: همان `type` در فهرست پروژه‌ها.
 * @liara/cli@9.6.0 package/lib/commands/app/list.js:8 بدنه `{projects:[]}`
 * @liara/cli@9.6.0 package/lib/commands/app/list.js:15-17 نام `project_id`، پلتفرم `type`
 * @liara/cli@9.6.0 package/lib/commands/app/list.js:13 زمان `created_at`
 * حافظه از assessSummaryMemory (واحد MB یا bytes). CPU بدون واحد cores استفاده نمی‌شود.
 */
export async function readSimilarUsage(platform: string, excludeApp: string): Promise<SimilarUsage> {
  try {
    const { data } = await liaraGet<unknown>(EP.listProjects);
    const match = newestSamePlatform(data, platform, excludeApp);
    if (!match) {
      return { memoryGB: null, cpuCores: null, similarApp: null, usageNote: "اپ دیگری با همین پلتفرم پیدا نشد." };
    }
    try {
      const summary = await liaraGet<unknown>(EP.metricsSummary(match.name));
      return usageFromSummary(match.name, summary.data);
    } catch {
      return {
        memoryGB: null,
        cpuCores: null,
        similarApp: match.name,
        usageNote: `مصرف اپ «${match.name}» خوانده نشد.`,
      };
    }
  } catch {
    return { memoryGB: null, cpuCores: null, similarApp: null, usageNote: "فهرست اپ‌ها خوانده نشد." };
  }
}

function newestSamePlatform(data: unknown, platform: string, excludeApp: string): ListedProject | null {
  const root = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const rows = Array.isArray(root["projects"]) ? root["projects"] : Array.isArray(data) ? data : [];
  const matches = rows
    .map((row) => listedProject(row))
    .filter((row): row is ListedProject => row !== null && row.type === platform && row.name !== excludeApp);
  matches.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return matches[0] ?? null;
}

function listedProject(row: unknown): ListedProject | null {
  if (!row || typeof row !== "object") return null;
  const record = row as Record<string, unknown>;
  const name = record["project_id"] ?? record["name"];
  const type = record["type"];
  if (typeof name !== "string" || typeof type !== "string") return null;
  const created = record["created_at"] ?? record["createdAt"];
  return { name, type, createdAt: typeof created === "string" ? created : "" };
}

export function usageFromSummary(app: string, raw: unknown): SimilarUsage {
  const memoryGB = explicitMemoryGB(raw);
  const cpuCores = cpuCoresFromSummary(raw);
  const notes = [
    memoryGB === null ? "واحد حافظه در metrics/summary نیامده و در انتخاب استفاده نشد." : "",
    cpuCores === null ? "واحد CPU در metrics/summary برابر cores نیست و در انتخاب استفاده نشد." : "",
  ].filter(Boolean);
  return { memoryGB, cpuCores, similarApp: app, usageNote: notes.join(" ") };
}

/** فقط واحد صریح. سقف ۶۵۵۳۶ در summary-memory حدس است و قیمت پلن را بالا نمی‌برد. */
function explicitMemoryGB(raw: unknown): number | null {
  const root = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const summary =
    root["summary"] && typeof root["summary"] === "object" ? (root["summary"] as Record<string, unknown>) : root;
  const unit = summary["memoryUnit"] ?? summary["memory_unit"];
  if (unit !== "MB" && unit !== "MiB" && unit !== "bytes" && unit !== "B") return null;
  const assessed = assessSummaryMemory(raw, null);
  if (!assessed.samples.length) return null;
  const peak = Math.max(...assessed.samples);
  return unit === "MB" || unit === "MiB" ? peak / 1024 : peak / (1024 * 1024 * 1024);
}

function cpuCoresFromSummary(raw: unknown): number | null {
  const root = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const summary =
    root["summary"] && typeof root["summary"] === "object" ? (root["summary"] as Record<string, unknown>) : root;
  const unit = summary["cpuUnit"] ?? summary["cpu_unit"];
  const value = summary["cpuCores"];
  if ((unit === "cores" || unit === "core") && typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return null;
}
