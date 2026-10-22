/**
 * Agate-Liara — بسته‌بندی سورس برای دیپلوی.
 *
 * قواعد:
 *  • `.gitignore` پروژه رعایت می‌شود.
 *  • همیشه排除 می‌شود: `.env`، `node_modules`، `.git`، `.agate` و فایل‌های سیستمی.
 *  • خروجی: یک آرشیو `.tar.gz` در پوشهٔ موقت.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ignore from "ignore";
import * as tar from "tar";

/** مسیرهایی که هرگز نباید در آرشیو باشند */
export const ALWAYS_EXCLUDE = [
  ".env",
  ".env.local",
  ".env.*.local",
  "node_modules",
  ".git",
  ".agate",
  ".DS_Store",
  "Thumbs.db",
  "*.log",
  ".npmrc",
  ".netrc",
  "id_rsa",
  "*.pem",
];

export interface PackResult {
  archivePath: string;
  bytes: number;
  fileCount: number;
  excluded: string[];
  root: string;
}

/** ساخت الگوی ignore بر پایهٔ .gitignore پروژه */
export function buildIgnore(root: string): ReturnType<typeof ignore> {
  const ig = ignore();
  const gitignore = path.join(root, ".gitignore");
  if (existsSync(gitignore)) {
    try {
      ig.add(readFileSync(gitignore, "utf8"));
    } catch {
      /* فایل .gitignore خراب → قواعد پیش‌فرض کافی است */
    }
  }
  ig.add(ALWAYS_EXCLUDE);
  ig.add(["dist", "coverage", ".next", ".cache", "*.tsbuildinfo"]);
  return ig;
}

/** آیا این مسیر باید از آرشیو حذف شود؟ */
export function isExcluded(relativePath: string, ig: ReturnType<typeof ignore>): boolean {
  const p = relativePath.replace(/\\/g, "/");
  if (!p || p === ".") return false;
  const name = p.split("/").pop() ?? "";
  if (name === ".env" || name.startsWith(".env.")) return true;
  if (p.split("/").includes("node_modules") || p.split("/").includes(".git")) return true;
  if (p.split("/").includes(".agate")) return true;
  return ig.ignores(p);
}

/** ساخت آرشیو tar.gz از یک پوشه */
export async function packageSource(root: string): Promise<PackResult> {
  const resolvedRoot = path.resolve(root);
  if (!existsSync(resolvedRoot)) {
    throw new Error(`پوشهٔ پروژه پیدا نشد: ${resolvedRoot}`);
  }
  const ig = buildIgnore(resolvedRoot);
  const excluded: string[] = [];
  const files: string[] = [];

  const walk = (dir: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(resolvedRoot, full).replace(/\\/g, "/");
      if (isExcluded(rel, ig)) {
        excluded.push(rel);
        continue;
      }
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        files.push(rel);
      }
    }
  };
  walk(resolvedRoot);

  const outDir = path.join(os.tmpdir(), "agate-liara-pack");
  mkdirSync(outDir, { recursive: true });
  const archivePath = path.join(outDir, `${path.basename(resolvedRoot)}-source.tar.gz`);
  if (existsSync(archivePath)) {
    unlinkSync(archivePath);
  }

  await tar.create(
    {
      gzip: true,
      file: archivePath,
      cwd: resolvedRoot,
      portable: true,
      noMtime: true,
    },
    files,
  );

  const size = statSync(archivePath).size;
  return { archivePath, bytes: size, fileCount: files.length, excluded, root: resolvedRoot };
}

/** قالب‌بندی حجم */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
