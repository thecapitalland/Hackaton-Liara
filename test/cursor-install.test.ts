import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { updateCursorMcp } from "../src/cursor-install.js";

test("install فقط agate-liara را عوض می‌کند و توکن نمی‌نویسد", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agate-mcp-"));
  const mcp = path.join(dir, "mcp.json");
  writeFileSync(
    mcp,
    JSON.stringify({
      mcpServers: {
        other: { command: "node", env: { LIARA_API_TOKEN: "leave-this-server" } },
      },
    }),
  );
  try {
    const result = updateCursorMcp(mcp, {
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\pkg\\dist\\index.js"],
      envFile: "C:\\pkg\\.env",
    });
    const written = JSON.parse(readFileSync(mcp, "utf8")) as {
      mcpServers: Record<string, { command?: string; args?: string[]; envFile?: string; env?: { LIARA_API_TOKEN?: string } }>;
    };
    assert.equal(written.mcpServers["other"]?.env?.LIARA_API_TOKEN, "leave-this-server");
    assert.equal(written.mcpServers["agate-liara"]?.args?.[0], path.resolve("C:\\pkg\\dist\\index.js"));
    assert.equal(written.mcpServers["agate-liara"]?.envFile, path.resolve("C:\\pkg\\.env"));
    assert.equal(JSON.stringify(written.mcpServers["agate-liara"]).includes("leave-this-server"), false);
    assert.ok(result.backupPath && existsSync(result.backupPath));
    assert.ok(readdirSync(dir).some((name) => name.startsWith("mcp.json.bak-")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
