/**
 * تست‌های بسته‌بندی (packager) و ادغام متغیرهای محیطی.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { buildIgnore, isExcluded, packageSource } from "../src/deploy/package.js";
import { mergeEnvVars } from "../src/tools/write.js";

/** فهرست فایل‌های داخل آرشیو */
async function listArchive(archivePath: string): Promise<string[]> {
  const files: string[] = [];
  await tar.list({
    file: archivePath,
    onentry: (entry) => files.push(entry.path.replace(/^\.\//, "")),
  });
  return files;
}

test("بسته‌بندی: فایل‌های حساس همیشه حذف می‌شوند", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agate-pack-"));
  try {
    mkdirSync(path.join(dir, "node_modules"), { recursive: true });
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, ".env"), "SECRET=abc\n");
    writeFileSync(path.join(dir, ".env.example"), "SECRET=\n");
    writeFileSync(path.join(dir, ".gitignore"), "dist/\n*.log\n");
    writeFileSync(path.join(dir, "package.json"), '{"name":"demo"}');
    writeFileSync(path.join(dir, "src", "index.js"), "console.log('hi')\n");
    writeFileSync(path.join(dir, "node_modules", "big.js"), "module.exports=1\n");
    writeFileSync(path.join(dir, ".git", "config"), "secret\n");
    writeFileSync(path.join(dir, "debug.log"), "log\n");

    const ig = buildIgnore(dir);
    assert.equal(isExcluded(".env", ig), true);
    assert.equal(isExcluded("node_modules/big.js", ig), true);
    assert.equal(isExcluded(".git/config", ig), true);
    assert.equal(isExcluded("debug.log", ig), true);
    assert.equal(isExcluded("src/index.js", ig), false);

    const packed = await packageSource(dir);
    const files = await listArchive(packed.archivePath);

    assert.ok(files.includes("src/index.js"), "سورس باید بسته‌بندی شود");
    assert.ok(!files.includes(".env"), ".env نباید بسته‌بندی شود");
    assert.ok(!files.some((f) => f.startsWith("node_modules")), "node_modules نباید بسته‌بندی شود");
    assert.ok(!files.some((f) => f.startsWith(".git/")), ".git نباید بسته‌بندی شود");
    assert.ok(files.includes(".gitignore"), ".gitignore باید بسته‌بندی شود");
    assert.ok(!files.includes("debug.log"), "فایل لاگ نباید بسته‌بندی شود");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ادغام متغیرهای محیطی هیچ کلید موجودی را حذف نمی‌کند", () => {
  const current = [
    { key: "PORT", value: "3000" },
    { key: "KEEP_ME", value: "yes" },
  ];
  const merged = mergeEnvVars(current, [{ key: "NEW", value: "1" }]);
  const keys = merged.map((m) => m.key);
  assert.ok(keys.includes("PORT"));
  assert.ok(keys.includes("KEEP_ME"));
  assert.ok(keys.includes("NEW"));
  assert.equal(merged.find((m) => m.key === "PORT")!.value, "3000");
});

test("حذف صریح کلید فقط با unset انجام می‌شود", () => {
  const current = [
    { key: "A", value: "1" },
    { key: "B", value: "2" },
  ];
  const merged = mergeEnvVars(current, [{ key: "A", value: "9" }], ["B"]);
  assert.deepEqual(
    merged.map((m) => m.key).sort(),
    ["A"],
  );
  assert.equal(merged[0]!.value, "9");
});
