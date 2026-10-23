/**
 * مسیر پروژه برای deploy باید مطلق باشد تا سرور MCP به cwd خودش تکیه نکند.
 */
import { existsSync, statSync } from "node:fs";
import path from "node:path";

export function resolveProjectPath(input: string): string {
  const value = input.trim();
  if (!value || !path.isAbsolute(value)) {
    throw new Error("projectPath باید مسیر مطلق باشد؛ به پوشهٔ جاری سرور تکیه نمی‌شود.");
  }
  if (value.includes("\0")) throw new Error("مسیر پروژه نامعتبر است.");
  const resolved = path.resolve(value);
  if (!existsSync(resolved)) throw new Error(`مسیر پروژه وجود ندارد: ${resolved}`);
  let info;
  try {
    info = statSync(resolved);
  } catch {
    throw new Error(`مسیر پروژه خوانده نشد: ${resolved}`);
  }
  if (!info.isDirectory()) throw new Error("projectPath باید یک پوشه باشد.");
  return resolved;
}

/** مسیر پروب: فقط path نسبیِ ریشه، بدون پروتکل و بدون .. */
export function sanitizeProbePaths(paths: readonly string[] | undefined): string[] {
  if (!paths) return [];
  const out: string[] = [];
  for (const item of paths) {
    if (typeof item !== "string") continue;
    const value = item.trim();
    if (!value.startsWith("/") || value.startsWith("//")) continue;
    if (value.includes("..") || value.includes("\\") || value.includes("://") || value.length > 200) continue;
    if (!out.includes(value)) out.push(value);
  }
  return out;
}
