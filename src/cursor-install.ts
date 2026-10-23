/**
 * به‌روزرسانی فقط ورودی agate-liara در mcp.json.
 * بقیهٔ سرورها دست نمی‌خورند و توکن نوشته نمی‌شود.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface CursorMcpEntry {
  command: string;
  args: string[];
  envFile: string;
}

export interface CursorInstallResult {
  mcpPath: string;
  backupPath: string | null;
  command: string;
  args: string[];
  envFile: string;
}

function agateEntry(entry: CursorMcpEntry): Record<string, unknown> {
  const args = entry.args.map((item) => path.resolve(item));
  const envFile = path.resolve(entry.envFile);
  if (!args.length || !path.isAbsolute(args[0] ?? "")) {
    throw new Error("مسیر dist/index.js باید مطلق باشد.");
  }
  if (!path.isAbsolute(envFile)) throw new Error("envFile باید مطلق باشد.");
  return {
    type: "stdio",
    command: entry.command,
    args,
    envFile,
  };
}

export function updateCursorMcp(mcpPath: string, entry: CursorMcpEntry): CursorInstallResult {
  const nextEntry = agateEntry(entry);
  const serializedEntry = JSON.stringify(nextEntry);
  if (/LIARA_API_TOKEN|LLM_API_KEY|ADMIN_KEY|Bearer |api[_-]?key/i.test(serializedEntry)) {
    throw new Error("ورودی agate-liara نباید توکن داشته باشد.");
  }
  mkdirSync(path.dirname(mcpPath), { recursive: true });
  let backupPath: string | null = null;
  let root: Record<string, unknown> = {};
  if (existsSync(mcpPath)) {
    backupPath = `${mcpPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(mcpPath, backupPath);
    const parsed = JSON.parse(readFileSync(mcpPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("mcp.json باید یک شیء JSON باشد.");
    }
    root = parsed as Record<string, unknown>;
  }
  const current =
    root["mcpServers"] && typeof root["mcpServers"] === "object" && !Array.isArray(root["mcpServers"])
      ? { ...(root["mcpServers"] as Record<string, unknown>) }
      : {};
  const others = { ...current };
  delete others["agate-liara"];
  const servers = { ...others, "agate-liara": nextEntry };
  writeFileSync(mcpPath, `${JSON.stringify({ ...root, mcpServers: servers }, null, 2)}\n`, "utf8");
  const written = JSON.parse(readFileSync(mcpPath, "utf8")) as { mcpServers?: Record<string, unknown> };
  for (const [name, value] of Object.entries(others)) {
    if (JSON.stringify(written.mcpServers?.[name]) !== JSON.stringify(value)) {
      throw new Error(`سرور ${name} نباید تغییر می‌کرد.`);
    }
  }
  return {
    mcpPath,
    backupPath,
    command: String(nextEntry["command"]),
    args: nextEntry["args"] as string[],
    envFile: String(nextEntry["envFile"]),
  };
}
