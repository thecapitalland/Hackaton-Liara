import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getApproval, listApprovals, setElicitor } from "../src/approval.js";
import { PACKAGE_ROOT, registerOwnedApp } from "../src/config.js";
import { explainDeployFailure } from "../src/diagnose/deploy-failure.js";
import { logsV2Query, metricsSince } from "../src/liara/queries.js";
import { connectionDigest, readPreflightGate } from "../src/liara/preflight-gate.js";
import { deployStopStage, runDeployProject, shouldExplainEnsureStop } from "../src/tools/composite.js";

test("لاگ v2 زمان یونیکس‌ثانیه می‌فرستد و since متریک سی روز نیست", () => {
  const now = Date.parse("2026-10-23T16:00:00.000Z");
  const logs = logsV2Query(now - 15 * 60_000, true);
  assert.equal(logs.start, Math.floor((now - 15 * 60_000) / 1000));
  assert.equal(logs.direction, "forward");
  assert.equal(logs.last_lines, true);
  assert.equal(typeof logs.start, "number");
  const since = metricsSince(now);
  assert.equal(since, Math.floor((now - 30 * 60_000) / 1000));
  assert.notEqual(since, 30);
  assert.ok(since > Math.floor(now / 1000) - 8 * 24 * 60 * 60);
});

test("رسید preflight گم، منقضی و آماده را جدا می‌کند", () => {
  const state = mkdtempSync(path.join(tmpdir(), "agate-gate-"));
  const file = path.join(state, "preflight-gate.json");
  assert.equal(readPreflightGate(Date.now(), state).reason, "missing");
  writeFileSync(file, JSON.stringify({ connection: connectionDigest(), ready: false, ranAt: "2026-10-23T16:00:00.000Z" }));
  assert.equal(readPreflightGate(Date.now(), state).reason, "not_ready");
  writeFileSync(file, JSON.stringify({ connection: connectionDigest(), ready: true, ranAt: "2026-10-22T16:00:00.000Z" }));
  assert.equal(readPreflightGate(Date.parse("2026-10-23T16:00:00.000Z"), state).reason, "expired");
  writeFileSync(file, JSON.stringify({ connection: "other", ready: true, ranAt: "2026-10-23T16:00:00.000Z" }));
  assert.equal(readPreflightGate(Date.parse("2026-10-23T16:00:00.000Z"), state).reason, "connection");
  writeFileSync(file, JSON.stringify({ connection: connectionDigest(), ready: true, ranAt: "2026-10-23T15:00:00.000Z" }));
  assert.equal(readPreflightGate(Date.parse("2026-10-23T16:00:00.000Z"), state).reason, "ready");
});

test("preflight ردشده تشخیص فارسی می‌دهد و نوشتن پیشنهاد نمی‌کند", async () => {
  const explained = await explainDeployFailure({
    stage: "preflight",
    error: 'logs v2: 400 ❌ "start" must be a number',
    probes: [{ name: "logs v2: agate-liara", status: 400, error: '❌ "start" must be a number' }],
  }, { useModel: false });
  assert.equal(explained.cause, "preflight_query");
  assert.equal(explained.layer, "rules");
  assert.equal(explained.next, "explain_only");
  assert.match(explained.text, /شکل درخواست/);
  assert.match(explained.text, /logs v2/);
  assert.match(explained.text, /کارت تأییدی ساخته نشد/);
  assert.equal(explained.text.includes("Bearer"), false);
});

test("علت خارج از فهرست Jev پذیرفته نمی‌شود و کارت بدون اقدام ساخته نمی‌شود", async () => {
  const explained = await explainDeployFailure({
    stage: "build",
    error: "build failed",
    releaseId: "rel-1",
    releaseStatus: "FAILED",
    buildLogTail: ["npm ERR! missing script"],
  }, {
    useModel: true,
    callJev: async () => ({ answers: { cause: { choice: "restart_now" } } }),
    callModel: async () => ({ choices: [{ message: { content: '{"cause":"delete_app","explanationFa":"POST کن"}' } }] }),
  });
  assert.equal(explained.cause, "build_failed");
  assert.equal(explained.layer, "rules");
  assert.equal(explained.next, "explain_only");
  assert.equal(explained.text.includes("POST کن"), false);
  assert.match(explained.text, /rel-1/);
  assert.match(explained.text, /npm ERR/);
});

test("Jev اگر علت مجاز بدهد همان لایه ثبت می‌شود", async () => {
  const explained = await explainDeployFailure({
    stage: "preflight",
    error: "dns zones: 503 Service Unavailable",
    probes: [{ name: "dns zones", status: 503, error: "Service Unavailable" }],
  }, {
    useModel: true,
    callJev: async (body) => {
      const criteria = (body["questions"] as { cause: { criteria: Record<string, string> } }).cause.criteria;
      assert.equal(typeof criteria["preflight_provider"], "string");
      return { answers: { cause: { choice: "preflight_provider" } } };
    },
    callModel: async () => { throw new Error("نباید به deepseek برسد"); },
  });
  assert.equal(explained.layer, "jev");
  assert.equal(explained.cause, "preflight_provider");
  assert.match(explained.text, /نوشتنی فرستاده نشد/);
});

test("دیسک و سلامت به‌اشتباه بیلد خوانده نمی‌شوند و کارت اول ساخت جدا می‌ماند", () => {
  assert.equal(deployStopStage({ code: "DISK_SIZE_REQUIRED" }), "disk");
  assert.equal(deployStopStage({ stage: "build", releaseID: "rel-1" }), "build");
  assert.equal(deployStopStage({ health: false, releaseID: "rel-1", ok: false }), "deploy");
  assert.equal(shouldExplainEnsureStop({ note: "⏳ نیاز به تأیید", code: "APPROVAL_REQUIRED" }), false);
  assert.equal(shouldExplainEnsureStop({
    note: "⏳ نیاز به تأیید\n🔑 شناسهٔ تأیید: card-1",
    code: "APPROVAL_REQUIRED",
    failure: true,
  }), true);
});

test("سلامت ناموفق و دیسک علت خودشان را می‌گیرند و کارت تازه نمی‌سازند", async () => {
  const health = await explainDeployFailure({
    stage: "deploy",
    error: "⚠️ پروب سلامت موفق نشد",
    releaseId: "rel-ready",
    releaseStatus: "READY",
  }, { useModel: false });
  assert.equal(health.cause, "health_unconfirmed");
  assert.equal(health.next, "explain_only");
  const disk = await explainDeployFailure({
    stage: "disk",
    error: "هیچ POST ساخت دیسک و هیچ release با این mount فرستاده نمی‌شود.",
  }, { useModel: false });
  assert.equal(disk.cause, "disk_blocked");
  assert.equal(disk.next, "explain_only");
});

test("نبود شبکه یک کارت می‌سازد و تشخیص کارت دوم نمی‌سازد", async () => {
  const state = mkdtempSync(path.join(tmpdir(), "agate-network-explain-"));
  const previous = process.env.AGATE_STATE_DIR;
  process.env.AGATE_STATE_DIR = state;
  writeFileSync(
    path.join(state, "preflight-gate.json"),
    JSON.stringify({ connection: connectionDigest(), ready: true, ranAt: new Date().toISOString() }),
  );
  setElicitor(null);
  const original = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = async (url, init) => {
    methods.push(init?.method ?? "GET");
    const href = String(url);
    if (href.includes("/v1/networks")) {
      return new Response(JSON.stringify({ networks: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (href.includes("/v1/projects/new-app")) {
      return new Response(JSON.stringify({ message: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const res = await runDeployProject(
      { projectPath: PACKAGE_ROOT, app: "new-app" },
      { stateDir: state, useModel: false },
    );
    const text = res.content?.find((item) => item.type === "text")?.text ?? "";
    assert.equal(res.structuredContent?.["code"], "NETWORK_REQUIRED");
    assert.equal(res.structuredContent?.["cause"], "network_blocked");
    assert.equal(res.structuredContent?.["next"], "approval_card");
    assert.match(text, /علت:/);
    assert.match(text, /liara_create_network/);
    assert.equal(listApprovals().filter((item) => item.app === "new-app").length, 1);
    assert.ok(methods.every((method) => method === "GET"));
  } finally {
    globalThis.fetch = original;
    setElicitor(null);
    if (previous === undefined) delete process.env.AGATE_STATE_DIR;
    else process.env.AGATE_STATE_DIR = previous;
  }
});

test("deploy_project با preflight ردشده به تشخیص می‌رسد و درخواستی نمی‌فرستد", async () => {
  const state = mkdtempSync(path.join(tmpdir(), "agate-deploy-preflight-"));
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("نباید شبکه صدا زده شود"); };
  try {
    const res = await runDeployProject(
      { projectPath: PACKAGE_ROOT, app: "agate-liara" },
      {
        stateDir: state,
        useModel: false,
        runPreflight: async () => ({
          ranAt: "2026-10-23T16:00:00.000Z",
          ready: false,
          probes: [{ name: "metrics cpu: agate-liara", path: "/cpu", status: 503, ok: false, error: "Service Unavailable", durationMs: 1 }],
        }),
      },
    );
    assert.equal(res.structuredContent?.["code"], "PREFLIGHT_FAILED");
    assert.equal(res.structuredContent?.["cause"], "preflight_provider");
    assert.equal(res.structuredContent?.["next"], "explain_only");
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("اپ موجود کارت env با وضعیت کلید و کارت انتشار بدون دیسک غایب می‌سازد", async () => {
  const state = mkdtempSync(path.join(tmpdir(), "agate-wallex-continue-"));
  const project = mkdtempSync(path.join(tmpdir(), "agate-wallex-src-"));
  const previous = process.env.AGATE_STATE_DIR;
  process.env.AGATE_STATE_DIR = state;
  writeFileSync(
    path.join(state, "preflight-gate.json"),
    JSON.stringify({ connection: connectionDigest(), ready: true, ranAt: new Date().toISOString() }),
  );
  writeFileSync(path.join(project, "liara.json"), JSON.stringify({
    platform: "docker",
    port: 8000,
    disks: [{ name: "data", mountTo: "/app/data" }],
  }));
  writeFileSync(path.join(project, "app.py"), 'import os\nos.getenv("API_TOKEN")\n');
  writeFileSync(path.join(project, ".env.example"), "API_TOKEN=super-secret-value\n");
  writeFileSync(path.join(project, ".env"), "MODE=mode-fixture\nEMPTY_KEY=\nPORT=3000\nBOX_ONLY=set-fixture\n");
  registerOwnedApp("sample-bot");
  setElicitor(null);
  const original = globalThis.fetch;
  const methods: string[] = [];
  const paths: string[] = [];
  globalThis.fetch = async (url, init) => {
    methods.push(init?.method ?? "GET");
    const pathname = new URL(String(url)).pathname;
    paths.push(pathname);
    if (pathname === "/v1/projects/sample-bot/disks") {
      return new Response(JSON.stringify({ error: "Internal Server Error" }), { status: 500 });
    }
    if (pathname === "/v1/projects/sample-bot") {
      return new Response(JSON.stringify({ project: { _id: "pid123", project_id: "sample-bot" } }), { status: 200 });
    }
    if (pathname === "/v1/projects/pid123/disks") {
      return new Response(JSON.stringify({ disks: [], mounts: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  };
  try {
    const res = await runDeployProject(
      { projectPath: project, app: "sample-bot" },
      { stateDir: state, useModel: false },
    );
    const text = res.content?.find((item) => item.type === "text")?.text ?? "";
    assert.equal(res.structuredContent?.["code"], "APPROVAL_REQUIRED");
    assert.match(text, /MODE — تنظیم‌شده/);
    assert.match(text, /EMPTY_KEY — خالی/);
    assert.match(text, /API_TOKEN — خالی/);
    assert.match(text, /BOX_ONLY — تنظیم‌شده/);
    assert.equal(text.includes("mode-fixture"), false);
    assert.equal(text.includes("set-fixture"), false);
    assert.equal(text.includes("super-secret-value"), false);
    assert.equal(text.includes("PORT —"), false);
    assert.match(text, /data → \/app\/data/);
    assert.equal(paths.includes("/v1/projects/sample-bot/disks"), false);
    assert.ok(paths.includes("/v1/projects/pid123/disks"));
    assert.ok(methods.every((method) => method === "GET"));
    const ids = [...text.matchAll(/شناسهٔ تأیید: ([0-9a-f-]{36})/g)].map((match) => match[1] ?? "");
    assert.equal(ids.length, 2);
    const cards = ids.map((id) => getApproval(id));
    const envCard = cards.find((card) => card?.tool === "liara_set_env");
    const deployCard = cards.find((card) => card?.tool === "liara_deploy");
    const variables = (envCard?.params["variables"] ?? []) as { key: string; value: string }[];
    assert.equal(variables.find((row) => row.key === "MODE")?.value, "mode-fixture");
    assert.equal(variables.some((row) => row.key === "EMPTY_KEY"), false);
    assert.equal(envCard?.params["awaitingValues"], undefined);
    assert.deepEqual(deployCard?.params["releaseDisks"], []);
    const omitted = deployCard?.params["disksOmitted"] as { name: string }[];
    assert.equal(omitted[0]?.name, "data");
    assert.equal(listApprovals().filter((item) => item.app === "sample-bot").length, 2);
  } finally {
    globalThis.fetch = original;
    setElicitor(null);
    if (previous === undefined) delete process.env.AGATE_STATE_DIR;
    else process.env.AGATE_STATE_DIR = previous;
    rmSync(state, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});
