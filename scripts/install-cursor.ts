/**
 * ورودی agate-liara را در mcp.json کاربر می‌نویسد.
 * توکن را کپی نمی‌کند و بقیهٔ سرورها را تغییر نمی‌دهد.
 */
import os from "node:os";
import path from "node:path";
import { PACKAGE_ROOT } from "../src/config.js";
import { updateCursorMcp } from "../src/cursor-install.js";

const result = updateCursorMcp(path.join(os.homedir(), ".cursor", "mcp.json"), {
  command: process.execPath,
  args: [path.join(PACKAGE_ROOT, "dist", "index.js")],
  envFile: path.join(PACKAGE_ROOT, ".env"),
});
console.log(`mcp=${result.mcpPath}`);
console.log(`backup=${result.backupPath ?? "none"}`);
console.log(`command=${result.command}`);
console.log(`args=${result.args[0] ?? ""}`);
console.log(`envFile=${result.envFile}`);
