import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { isAllowedApp, registerOwnedApp } from "../src/config.js";
import { appWriteAllowed, checkScope } from "../src/tools/write.js";

test("اپ خارج از allowlist و owned رد می‌شود و اپ ثبت‌شده مجاز می‌شود", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agate-owned-"));
  const previous = process.env["AGATE_STATE_DIR"];
  process.env["AGATE_STATE_DIR"] = dir;
  try {
    assert.equal(isAllowedApp("agate-liara"), true);
    assert.equal(isAllowedApp("not-owned-app"), false);
    assert.equal(appWriteAllowed("liara_restart", "not-owned-app"), false);
    assert.equal(appWriteAllowed("liara_create_app", "not-owned-app"), true);
    assert.equal(appWriteAllowed("liara_create_network", "not-owned-app"), true);
    registerOwnedApp("cursor-owned-app", dir);
    assert.equal(isAllowedApp("cursor-owned-app"), true);
    assert.equal(appWriteAllowed("liara_deploy", "cursor-owned-app"), true);
    const file = JSON.parse(readFileSync(path.join(dir, "owned-apps.json"), "utf8")) as { apps: string[] };
    assert.deepEqual(file.apps, ["cursor-owned-app"]);
  } finally {
    if (previous === undefined) delete process.env["AGATE_STATE_DIR"];
    else process.env["AGATE_STATE_DIR"] = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SSL اپ owned که در allowlist نیست پذیرفته می‌شود", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agate-owned-ssl-"));
  const previous = process.env["AGATE_STATE_DIR"];
  process.env["AGATE_STATE_DIR"] = dir;
  try {
    registerOwnedApp("cursor-owned-app", dir);
    const seen: string[] = [];
    const allowed = await checkScope("liara_enable_ssl", { domain: "app.example.com" }, async (app) => {
      seen.push(app);
      return app === "cursor-owned-app" ? [{ name: "app.example.com" }] : [];
    });
    assert.equal(allowed, null);
    assert.ok(seen.includes("cursor-owned-app"));
    const rejected = await checkScope("liara_enable_ssl", { domain: "other.example.com" }, async () => []);
    assert.match(rejected ?? "", /مجاز/);
  } finally {
    if (previous === undefined) delete process.env["AGATE_STATE_DIR"];
    else process.env["AGATE_STATE_DIR"] = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
