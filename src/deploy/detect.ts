/**
 * Agate-Liara — تشخیص استک پروژه برای دیپلوی.
 * فقط خواندنی: فایل‌های پروژه خوانده می‌شوند، چیزی تغییر نمی‌کند.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export type Platform = "node" | "docker" | "python" | "static" | "unknown";

export interface DiskMount {
  name: string;
  mountTo: string;
  /**
   * فقط وقتی liara.json کلید size دارد.
   * @liara/cli@9.6.0 package/lib/types/disk.d.ts این فیلد را ندارد؛
   * نبودش یعنی اندازه حدس زده نمی‌شود.
   */
  size?: string;
}

export interface StackDetection {
  platform: Platform;
  /** پورت سرویس */
  port?: number;
  /** نام پیشنهادی اپ */
  app: string;
  /** کلیدهای متغیر محیطی که کد به آن‌ها نیاز دارد */
  requiredEnv: string[];
  /** کلیدهای تعریف‌شده در .env.example */
  exampleEnv: string[];
  /** اسکریپت/دستور اجرا */
  startCommand?: string;
  /** disks در liara.json. mount در release با {name, mountTo} فرستاده می‌شود. */
  disks?: DiskMount[];
  /** نام فایل Dockerfile اگر پیدا شده باشد. */
  dockerfile?: string;
  notes: string[];
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".agate", "dist", "build", ".next", ".cache", "coverage"]);

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** پیمایش فایل‌های پروژه (بدون ورود به پوشه‌های سنگین) */
function walk(root: string, maxFiles = 1500): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(entry)) continue;
        stack.push(full);
      } else if (st.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

/** اسکن `process.env.X` در سورس */
export function scanEnvUsage(files: string[]): string[] {
  const found = new Set<string>();
  const re = /process\.env(?:\.([A-Z0-9_]+)|\[\s*['"]([A-Z0-9_]+)['"]\s*\])/g;
  for (const file of files) {
    const nodeFile = /\.(ts|js|mjs|cjs|tsx|jsx)$/i.test(file);
    const pythonFile = /\.py$/i.test(file);
    if (!nodeFile && !pythonFile) continue;
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (content.length > 2_000_000) continue;
    const pattern = nodeFile
      ? re
      : /os\.(?:environ\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]|environ\.get\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]|getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"])/g;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
      const key = m[1] ?? m[2] ?? m[3];
      if (key) found.add(key);
    }
  }
  return [...found].sort();
}

/** کلیدهای .env.example */
export function readExampleEnv(root: string): string[] {
  const file = path.join(root, ".env.example");
  if (!existsSync(file)) return [];
  const out: string[] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(trimmed);
    if (m?.[1]) out.push(m[1]);
  }
  return [...new Set(out)];
}

/** تشخیص استک */
export function detectStack(root: string, requestedApp?: string): StackDetection {
  const notes: string[] = [];
  const resolvedRoot = path.resolve(root);
  const pkg = existsSync(path.join(resolvedRoot, "package.json"))
    ? readJson(path.join(resolvedRoot, "package.json"))
    : null;
  const liaraJson = existsSync(path.join(resolvedRoot, "liara.json"))
    ? readJson(path.join(resolvedRoot, "liara.json"))
    : null;

  const exampleEnv = readExampleEnv(resolvedRoot);
  const files = walk(resolvedRoot);
  const envUsage = scanEnvUsage(files);

  let platform: Platform = "unknown";
  let port: number | undefined;
  let startCommand: string | undefined;
  const declared =
    typeof liaraJson?.["platform"] === "string" ? String(liaraJson["platform"]).trim().toLowerCase() : "";
  const declaredDirect = (["node", "docker", "python", "static"] as const).find((item) => item === declared);

  const dockerfile = ["Dockerfile", "dockerfile", "Dockerfile.prod"].find((f) =>
    existsSync(path.join(resolvedRoot, f)),
  );
  const scripts = (pkg?.["scripts"] as Record<string, string> | undefined) ?? {};
  const start = scripts["start"] ?? scripts["serve"] ?? undefined;
  if (start) startCommand = `npm run start (${start})`;
  else if (scripts["dev"]) startCommand = `npm run dev (${scripts["dev"]})`;

  if (declaredDirect) {
    platform = declaredDirect;
    notes.push(`liara.json platform=${declaredDirect} بر تشخیص فایل‌ها اولویت دارد.`);
  } else {
    if (declared) {
      notes.push(
        `liara.json platform=${declared} در فهرست ساخت اپ (node، docker، python، static) نیست؛ تشخیص از روی فایل‌ها انجام شد.`,
      );
    }
    if (dockerfile) {
      platform = "docker";
      notes.push(`Dockerfile پیدا شد (${dockerfile}) → پلتفرم docker.`);
    } else if (pkg) {
      platform = "node";
      notes.push(`package.json پیدا شد → پلتفرم node${startCommand ? ` (${startCommand})` : ""}.`);
    } else if (existsSync(path.join(resolvedRoot, "requirements.txt"))) {
      platform = "python";
      notes.push("requirements.txt پیدا شد → پلتفرم python.");
    } else if (existsSync(path.join(resolvedRoot, "index.html"))) {
      platform = "static";
      notes.push("index.html پیدا شد → پلتفرم static.");
    }
  }

  // پورت
  const liaraPort = liaraJson?.["port"];
  if (typeof liaraPort === "number") port = liaraPort;
  if (typeof liaraJson?.["port"] === "string") port = Number.parseInt(String(liaraJson["port"]), 10);
  if (!port && exampleEnv.includes("PORT")) notes.push("پورت از متغیر PORT در .env.example برداشته شد (پیش‌فرض ۳۰۰۰).");
  if (!port) {
    for (const file of files) {
      if (!/\.(ts|js|mjs|cjs)$/i.test(file)) continue;
      let content = "";
      try {
        content = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const m = /process\.env\.PORT\s*\|\|\s*(\d{2,5})/.exec(content);
      if (m?.[1]) {
        port = Number.parseInt(m[1], 10);
        notes.push(`پورت ${port} از کد تشخیص داده شد.`);
        break;
      }
    }
  }
  if (!port) port = 3000;

  const app =
    requestedApp ??
    (typeof liaraJson?.["app"] === "string" ? (liaraJson["app"] as string) : undefined) ??
    (typeof pkg?.["name"] === "string" ? (pkg["name"] as string) : undefined) ??
    path.basename(resolvedRoot);

  const requiredEnv = [...new Set([...envUsage, ...exampleEnv])].filter(
    (k) => k !== "PORT" && k !== "NODE_ENV",
  );

  return {
    platform,
    port,
    app: app.replace(/[^a-z0-9-]/gi, "-").toLowerCase(),
    requiredEnv,
    exampleEnv,
    startCommand,
    disks: readDiskMounts(liaraJson),
    ...(dockerfile ? { dockerfile } : {}),
    notes,
  };
}

function readDiskMounts(liaraJson: Record<string, unknown> | null): DiskMount[] {
  const rows = liaraJson?.["disks"];
  if (!Array.isArray(rows)) return [];
  const out: DiskMount[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const name = (row as Record<string, unknown>)["name"];
    const mountTo = (row as Record<string, unknown>)["mountTo"];
    if (typeof name === "string" && name.trim() && typeof mountTo === "string" && mountTo.trim()) {
      const size = readDiskSize((row as Record<string, unknown>)["size"]);
      out.push(size ? { name: name.trim(), mountTo: mountTo.trim(), size } : { name: name.trim(), mountTo: mountTo.trim() });
    }
  }
  return out;
}

/** probePaths اختیاری در liara.json. فیلد رسمی لیارا نیست. */
export function readProbePaths(root: string): string[] {
  const file = path.join(root, "liara.json");
  if (!existsSync(file)) return [];
  const json = readJson(file);
  const rows = json?.["probePaths"];
  if (!Array.isArray(rows)) return [];
  return rows.filter(
    (item): item is string =>
      typeof item === "string" && item.startsWith("/") && !item.startsWith("//") && !item.includes(".."),
  );
}

/** اندازهٔ اختیاری. الگوی ساخت دیسک CLI رشته است؛ عدد محدود هم پذیرفته می‌شود. مقدار نامعتبر حذف می‌شود. */
export function readDiskSize(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return String(value);
  if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim())) return value.trim();
  return undefined;
}
