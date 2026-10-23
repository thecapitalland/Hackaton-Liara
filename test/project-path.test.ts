import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { detectStack, scanEnvUsage } from "../src/deploy/detect.js";
import { resolveProjectPath } from "../src/deploy/project-path.js";
import { buildReleaseBody } from "../src/tools/composite.js";
import { envCardAfterCreate } from "../src/tools/write.js";

test("مسیر نسبی برای projectPath رد می‌شود", () => {
  assert.throws(() => resolveProjectPath("."), /مسیر مطلق/);
  assert.throws(() => resolveProjectPath("demo-site"), /مسیر مطلق/);
});

test("liara.json برای python و docker و disks بر فایل‌ها اولویت دارد و release فقط name و mountTo می‌فرستد", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agate-project-"));
  try {
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "sample", scripts: { start: "node server.js" } }));
    writeFileSync(
      path.join(dir, "liara.json"),
      JSON.stringify({
        platform: "python",
        port: 8000,
        disks: [{ name: "data", mountTo: "/data" }],
        probePaths: ["/health", "../secret"],
      }),
    );
    writeFileSync(path.join(dir, "app.py"), 'import os\nos.getenv("API_TOKEN")\n');
    const python = detectStack(dir, "sample-app");
    assert.equal(python.platform, "python");
    assert.equal(python.port, 8000);
    assert.deepEqual(python.disks, [{ name: "data", mountTo: "/data" }]);
    assert.ok(python.requiredEnv.includes("API_TOKEN"));
    const body = buildReleaseBody(python, "src_1");
    assert.equal(body["type"], "python");
    assert.equal(body["port"], 8000);
    assert.deepEqual(body["disks"], [{ name: "data", mountTo: "/data" }]);

    writeFileSync(path.join(dir, "liara.json"), JSON.stringify({ platform: "docker", port: 8080 }));
    writeFileSync(path.join(dir, "Dockerfile.prod"), "FROM python:3.12\n");
    const docker = detectStack(dir);
    assert.equal(docker.platform, "docker");
    assert.equal(docker.dockerfile, "Dockerfile.prod");
    const dockerBody = buildReleaseBody(docker, "src_2");
    const build = dockerBody["build"] as { dockerfile?: string };
    assert.equal(build.dockerfile, "Dockerfile.prod");
    assert.equal("disks" in dockerBody, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("os.environ.get در کارت env فقط نام کلید را می‌آورد", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agate-py-"));
  const state = mkdtempSync(path.join(tmpdir(), "agate-py-state-"));
  const previous = process.env["AGATE_STATE_DIR"];
  process.env["AGATE_STATE_DIR"] = state;
  try {
    writeFileSync(path.join(dir, "app.py"), 'import os\nos.environ.get("API_TOKEN")\n');
    writeFileSync(path.join(dir, ".env.example"), "API_TOKEN=super-secret-value\n");
    assert.deepEqual(scanEnvUsage([path.join(dir, "app.py")]), ["API_TOKEN"]);
    const card = envCardAfterCreate("sample-app", dir);
    assert.match(card, /API_TOKEN/);
    assert.equal(card.includes("super-secret-value"), false);
  } finally {
    if (previous === undefined) delete process.env["AGATE_STATE_DIR"];
    else process.env["AGATE_STATE_DIR"] = previous;
    rmSync(dir, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});
