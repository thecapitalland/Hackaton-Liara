import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createPendingApproval, setApprovalStatus, setElicitor } from "../src/approval.js";
import { ensureApp } from "../src/tools/composite.js";
import { executeStoredAction } from "../src/tools/write.js";
import { connectionDigest } from "../src/liara/preflight-gate.js";
import { parsePlanCatalog } from "../src/liara/plans.js";
import {
  diskFloorGB,
  excludeRejectedPlan,
  presentPlanChoice,
  presentReplacement,
  readPlanErrorCode,
} from "../src/liara/plan-choice.js";
import { usageFromSummary } from "../src/liara/similar-usage.js";
import type { PlanPair } from "../src/liara/plans.js";

function plan(ram: number, cpu: number, volume: number, displayPrice: number) {
  return { available: true, region: "iran", displayPrice, volume, RAM: { amount: ram }, CPU: { amount: cpu } };
}

function catalog() {
  return {
    plans: {
      projects: {
        "small-g2": plan(0.5, 0.5, 5, 475000),
        "medium-g2": plan(1, 1, 10, 825000),
        "standard-base-g2": plan(2, 1, 20, 1475000),
        "ir-small": { available: true, region: "iran", price: 1319.44, volume: 5, RAM: { amount: 0.5 }, CPU: { amount: 0.5 } },
        free: { available: false, region: "iran", displayPrice: 0, volume: 1, RAM: { amount: 0.25 }, CPU: { amount: 0.1 } },
      },
      projectBundlePlans: {
        "small-g2": { basic: { available: true, displayPrice: 275000 }, standard: { available: true, displayPrice: 475000 } },
        "medium-g2": { basic: { available: true, displayPrice: 400000 } },
        "standard-base-g2": { basic: { available: true, displayPrice: 500000 } },
        "ir-small": { basic: { available: true, displayPrice: 100000 } },
        free: { free: { available: false, displayPrice: 0 } },
      },
    },
  };
}

function pairs(): PlanPair[] {
  return parsePlanCatalog(catalog()).pairs;
}

const emptyNeed = { platform: "node", diskGB: null, memoryGB: null, cpuCores: null, usageNote: "اپ دیگری با همین پلتفرم پیدا نشد." };

test("کارت ساخت فقط پلن مجاز CLI را با قیمت واقعی و کف دیسک پیشنهاد می‌کند", () => {
  const parsed = parsePlanCatalog(catalog());
  assert.ok(parsed.pairs.every((pair) => pair.planID.includes("g2")));
  assert.equal(parsed.pairs.some((pair) => pair.planID === "ir-small"), false);
  const choice = presentPlanChoice(parsed.pairs, { ...emptyNeed, platform: "docker", diskGB: 8 });
  assert.ok(choice);
  assert.equal(choice.recommended.planID, "medium-g2");
  assert.equal(choice.recommended.bundlePlanID, "basic");
  assert.equal(choice.recommended.totalMonthly, 1_225_000);
  assert.match(choice.reasonFa, /پلتفرم docker/);
  assert.match(choice.reasonFa, /دیسک 8/);
  assert.match(choice.cheaperFa, /small-g2/);
  assert.match(choice.strongerFa, /standard-base-g2/);
  assert.equal(choice.choices.filter((item) => item.recommended).length, 1);
});

test("بدون کف دیسک و مصرف، ارزان‌ترین پلن مجاز پیش‌فرض است و رم اپ مشابه کف را بالا می‌برد", () => {
  const choice = presentPlanChoice(pairs(), emptyNeed);
  assert.equal(choice?.recommended.planID, "small-g2");
  assert.match(choice?.reasonFa ?? "", /پلتفرم node/);
  assert.match(choice?.cheaperFa ?? "", /ارزان‌تر از این نیست/);
  const sized = presentPlanChoice(pairs(), {
    platform: "node",
    diskGB: null,
    memoryGB: 0.8,
    cpuCores: 0.8,
    similarApp: "agate-liara",
  });
  assert.equal(sized?.recommended.planID, "medium-g2");
  assert.match(sized?.reasonFa ?? "", /agate-liara/);
  assert.equal(diskFloorGB([{ size: "2" }, { size: "8" }, { size: "large" }]), 8);
  assert.equal(diskFloorGB([{ name: "data" } as { size?: string }]), null);
});

test("خطای پلن کارت جایگزین می‌سازد و همان پلن را دوباره پیشنهاد نمی‌کند", () => {
  const body = { statusCode: 400, message: "g2_plan_unavailable", data: { code: "g2_plan_unavailable" } };
  assert.equal(readPlanErrorCode(body), "g2_plan_unavailable");
  const follow = presentReplacement(pairs(), "small-g2", "basic", "g2_plan_unavailable", emptyNeed);
  assert.match(follow.explanationFa, /خودکار انجام نشد/);
  assert.equal(follow.presentation?.recommended.planID, "medium-g2");
  assert.equal(excludeRejectedPlan(pairs(), "small-g2", "basic", "g2_plan_unavailable").some((pair) => pair.planID === "small-g2"), false);
  assert.equal(presentReplacement(pairs(), "standard-base-g2", "basic", "g2_plan_unavailable", { ...emptyNeed, diskGB: 100 }).presentation?.fits, false);
});

test("حافظهٔ اپ مشابه فقط با واحد صریح به گیگابایت تبدیل می‌شود و CPU بدون cores کنار می‌ماند", () => {
  const untagged = usageFromSummary("agate-liara", { summary: { memoryUsage: [{ value: [[1, 900]] }] } });
  assert.equal(untagged.memoryGB, null);
  assert.match(untagged.usageNote, /حافظه/);
  const usage = usageFromSummary("agate-liara", { summary: { memoryUnit: "MB", memoryUsage: [{ value: [[1, 900]] }] } });
  assert.equal(usage.similarApp, "agate-liara");
  assert.ok(usage.memoryGB !== null && usage.memoryGB > 0.8 && usage.memoryGB < 0.9);
  assert.equal(usage.cpuCores, null);
  assert.match(usage.usageNote, /CPU/);
  const withCpu = usageFromSummary("agate-liara", {
    summary: { memoryUnit: "MB", cpuUnit: "cores", cpuCores: 0.4, memoryUsage: [{ value: [[1, 100]] }] },
  });
  assert.equal(withCpu.cpuCores, 0.4);
  assert.equal(withCpu.usageNote, "");
});

test("پیشنهاد ساخت بدون تأیید هیچ POSTی نمی‌زند", async () => {
  const state = mkdtempSync(path.join(tmpdir(), "agate-plan-card-"));
  const project = mkdtempSync(path.join(tmpdir(), "agate-plan-project-"));
  const previousState = process.env["AGATE_STATE_DIR"];
  const previousToken = process.env["LIARA_API_TOKEN"];
  process.env["AGATE_STATE_DIR"] = state;
  process.env["LIARA_API_TOKEN"] = "fixture-not-live";
  writeFileSync(path.join(project, "liara.json"), JSON.stringify({ platform: "node", disks: [{ name: "data", mountTo: "/data", size: "8" }] }));
  const methods: string[] = [];
  const original = globalThis.fetch;
  setElicitor(null);
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    methods.push(method);
    if (url.pathname === "/v1/me") return new Response(JSON.stringify(catalog()), { status: 200 });
    if (url.pathname === "/v1/projects") return new Response(JSON.stringify({ projects: [] }), { status: 200 });
    return new Response(JSON.stringify({ message: "missing" }), { status: 404 });
  };
  try {
    const out = await ensureApp("plan-choice-app", "node", undefined, undefined, undefined, project);
    assert.equal(out.code, "APPROVAL_REQUIRED");
    assert.match(out.note ?? "", /medium-g2/);
    assert.match(out.note ?? "", /small-g2/);
    assert.match(out.note ?? "", /standard-base-g2/);
    assert.match(out.note ?? "", /پلتفرم node/);
    assert.equal(out.note?.includes("ir-small"), false);
    assert.ok(methods.every((method) => method === "GET"));
  } finally {
    globalThis.fetch = original;
    setElicitor(null);
    if (previousState === undefined) delete process.env["AGATE_STATE_DIR"];
    else process.env["AGATE_STATE_DIR"] = previousState;
    if (previousToken === undefined) delete process.env["LIARA_API_TOKEN"];
    else process.env["LIARA_API_TOKEN"] = previousToken;
    rmSync(state, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("خطای g2_plan_unavailable فقط یک POST می‌زند و کارت جایگزین می‌خواهد", async () => {
  const state = mkdtempSync(path.join(tmpdir(), "agate-plan-reject-"));
  const previousState = process.env["AGATE_STATE_DIR"];
  const previousToken = process.env["LIARA_API_TOKEN"];
  process.env["AGATE_STATE_DIR"] = state;
  process.env["LIARA_API_TOKEN"] = "fixture-not-live";
  writeFileSync(
    path.join(state, "preflight-gate.json"),
    JSON.stringify({ connection: connectionDigest(), ready: true, ranAt: new Date().toISOString() }),
  );
  const methods: string[] = [];
  const original = globalThis.fetch;
  setElicitor(async (_summary, choices) => {
    const recommended = choices.find((choice) => choice.recommended);
    return { approved: true, choice: recommended?.value };
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    methods.push(`${method} ${url.pathname}`);
    if (method === "POST") {
      return new Response(
        JSON.stringify({ statusCode: 400, message: "g2_plan_unavailable", data: { code: "g2_plan_unavailable" } }),
        { status: 400 },
      );
    }
    if (url.pathname === "/v1/me") return new Response(JSON.stringify(catalog()), { status: 200 });
    if (url.pathname === "/v1/projects") return new Response(JSON.stringify({ projects: [] }), { status: 200 });
    return new Response(JSON.stringify({ message: "missing" }), { status: 404 });
  };
  try {
    const out = await ensureApp("plan-choice-app", "node");
    assert.equal(out.code, "APPROVAL_REQUIRED");
    assert.match(out.note ?? "", /خودکار انجام نشد/);
    assert.match(out.note ?? "", /medium-g2/);
    assert.equal(methods.filter((line) => line.startsWith("POST")).length, 1);
  } finally {
    globalThis.fetch = original;
    setElicitor(null);
    if (previousState === undefined) delete process.env["AGATE_STATE_DIR"];
    else process.env["AGATE_STATE_DIR"] = previousState;
    if (previousToken === undefined) delete process.env["LIARA_API_TOKEN"];
    else process.env["LIARA_API_TOKEN"] = previousToken;
    rmSync(state, { recursive: true, force: true });
  }
});

test("execute_action بعد از رد پلن قوی‌تر فقط یک POST می‌زند و همان پلن را دوباره پیشنهاد نمی‌کند", async () => {
  const state = mkdtempSync(path.join(tmpdir(), "agate-plan-execute-"));
  const previousState = process.env["AGATE_STATE_DIR"];
  const previousToken = process.env["LIARA_API_TOKEN"];
  process.env["AGATE_STATE_DIR"] = state;
  process.env["LIARA_API_TOKEN"] = "fixture-not-live";
  writeFileSync(
    path.join(state, "preflight-gate.json"),
    JSON.stringify({ connection: connectionDigest(), ready: true, ranAt: new Date().toISOString() }),
  );
  const parsed = parsePlanCatalog(catalog());
  const choice = presentPlanChoice(parsed.pairs, emptyNeed);
  assert.ok(choice);
  const stronger = choice.choices.find((item) => item.role === "stronger");
  assert.ok(stronger);
  const methods: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    methods.push(`${method} ${url.pathname}`);
    if (method === "POST") {
      return new Response(
        JSON.stringify({ statusCode: 400, message: "g2_plan_unavailable", data: { code: "g2_plan_unavailable" } }),
        { status: 400 },
      );
    }
    if (url.pathname === "/v1/me") return new Response(JSON.stringify(catalog()), { status: 200 });
    return new Response(JSON.stringify({ message: "missing" }), { status: 404 });
  };
  const record = createPendingApproval({
    tool: "liara_create_app",
    app: "plan-choice-app",
    params: {
      name: "plan-choice-app",
      planID: choice.recommended.planID,
      platform: "node",
      bundlePlanID: choice.recommended.bundlePlanID,
      quote: choice.recommended,
      planChoices: choice.choices,
      planNeed: emptyNeed,
      planReasonFa: choice.reasonFa,
      planCheaperFa: choice.cheaperFa,
      planStrongerFa: choice.strongerFa,
    },
    summaryFa: choice.reasonFa,
    risk: "high",
    impact: "تست",
    choices: choice.choices.map((item) => ({ value: item.value, labelFa: item.labelFa, recommended: item.recommended })),
  });
  setApprovalStatus(record.approvalId, "approved", stronger.value);
  try {
    const out = await executeStoredAction(record.approvalId);
    const structured = (out.structuredContent ?? {}) as Record<string, unknown>;
    const text = out.content[0]?.type === "text" ? out.content[0].text : "";
    assert.equal(structured["rejectedPlanID"], stronger.pair.planID);
    assert.notEqual(structured["replacementPlanID"], stronger.pair.planID);
    assert.match(text, /خودکار انجام نشد/);
    assert.equal(methods.filter((line) => line.startsWith("POST")).length, 1);
  } finally {
    globalThis.fetch = original;
    if (previousState === undefined) delete process.env["AGATE_STATE_DIR"];
    else process.env["AGATE_STATE_DIR"] = previousState;
    if (previousToken === undefined) delete process.env["LIARA_API_TOKEN"];
    else process.env["LIARA_API_TOKEN"] = previousToken;
    rmSync(state, { recursive: true, force: true });
  }
});
