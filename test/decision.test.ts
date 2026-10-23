/**
 * لایهٔ تصمیم: Jev، سپس JSON، سپس مدل جایگزین، سپس قواعد.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { decideIncident } from "../src/diagnose/decision.js";
import { RESTART_REMEDY } from "../src/diagnose/llm.js";
import { saveEnvBaseline } from "../src/env-history.js";
import { runDiagnosis } from "../src/tools/composite.js";
import type { Hypothesis } from "../src/types.js";

const summary = "صفحه ۵۰۰ است";

function jev(choice: string, extra: Record<string, unknown> = {}) {
  return {
    answers: {
      hypothesis: { choice, probabilities: { http_5xx: 0.8, crash_loop: 0.1 }, confidence: 0.8, ...extra },
      remedy: { choice: "restart" },
    },
    usage: { cost: 0.00003 },
  };
}

function jsonChoice(id: string) {
  return { choices: [{ message: { content: JSON.stringify({ hypotheses: [{ id, confidence: 0.7 }], remedy: "restart" }) } }] };
}

test("پاسخ معتبر Jev معیار را object می‌فرستد و احتمال و هزینه را برمی‌گرداند", async () => {
  let criteriaIsObject = false;
  const result = await decideIncident({
    decisionModel: "typesafe/jev-1.14",
    summary,
    remedies: [RESTART_REMEDY],
    evidenceIds: ["ev_1"],
    logs: [{ ts: null, level: "error", message: "status 500" }],
    probe: { url: "https://agate-liara.liara.run/", samples: [{ status: 500, latencyMs: 10 }], ok: false, p50: 10 },
    callJev: async (body) => {
      const questions = body["questions"] as { hypothesis?: { criteria?: unknown } };
      criteriaIsObject = Boolean(questions.hypothesis?.criteria) && !Array.isArray(questions.hypothesis?.criteria) && typeof questions.hypothesis?.criteria === "object";
      return jev("http_5xx");
    },
  });
  assert.equal(criteriaIsObject, true);
  assert.equal(result.ok, true);
  assert.equal(result.layer, "jev");
  assert.equal(result.hypotheses[0]?.id, "http_5xx");
  assert.equal(result.probabilities?.http_5xx, 0.8);
  assert.equal(result.cost, 0.00003);
});

test("پاسخ نامعتبر Jev به JSON مدل اصلی برمی‌گردد", async () => {
  const result = await decideIncident({
    decisionModel: "typesafe/jev-1.14",
    primaryModel: "deepseek-v4.1-flash",
    summary,
    remedies: [RESTART_REMEDY],
    evidenceIds: ["ev_1"],
    probe: { url: "https://agate-liara.liara.run/", samples: [{ status: 500, latencyMs: 10 }], ok: false, p50: 10 },
    callJev: async () => ({ answers: { hypothesis: { choice: "" } } }),
    callModel: async (model) => {
      assert.equal(model, "deepseek-v4.1-flash");
      return jsonChoice("http_5xx");
    },
  });
  assert.equal(result.layer, "deepseek");
  assert.equal(result.hypotheses[0]?.id, "http_5xx");
});

test("گزینهٔ خارج از allowlist رد می‌شود و مدل جایگزین تصمیم می‌گیرد", async () => {
  const seen: string[] = [];
  const result = await decideIncident({
    decisionModel: "typesafe/jev-1.14",
    primaryModel: "deepseek-v4.1-flash",
    fallbackModel: "gpt-4.1-mini",
    summary,
    remedies: [RESTART_REMEDY],
    evidenceIds: ["ev_1"],
    probe: { url: "https://agate-liara.liara.run/", samples: [{ status: 500, latencyMs: 10 }], ok: false, p50: 10 },
    callJev: async () => jev("delete_database"),
    callModel: async (model) => {
      seen.push(model);
      return model === "gpt-4.1-mini" ? jsonChoice("http_5xx") : { choices: [{ message: { content: "نه" } }] };
    },
  });
  assert.deepEqual(seen, ["deepseek-v4.1-flash", "deepseek-v4.1-flash", "gpt-4.1-mini"]);
  assert.equal(result.layer, "fallback");
  assert.equal(result.hypotheses[0]?.id, "http_5xx");
});

test("timeout Jev به مدل اصلی می‌رسد", async () => {
  const result = await decideIncident({
    decisionModel: "typesafe/jev-1.14",
    primaryModel: "deepseek-v4.1-flash",
    summary,
    remedies: [RESTART_REMEDY],
    evidenceIds: ["ev_1"],
    probe: { url: "https://agate-liara.liara.run/", samples: [{ status: 500, latencyMs: 10 }], ok: false, p50: 10 },
    callJev: async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    },
    callModel: async () => jsonChoice("slow_responses"),
  });
  assert.equal(result.ok, true);
  assert.equal(result.layer, "deepseek");
  assert.equal(result.hypotheses[0]?.id, "slow_responses");
});

test("شکست هر سه لایه به قواعد برمی‌گردد", async () => {
  const result = await decideIncident({
    decisionModel: "typesafe/jev-1.14",
    primaryModel: "deepseek-v4.1-flash",
    fallbackModel: "gpt-4.1-mini",
    summary,
    remedies: [RESTART_REMEDY],
    evidenceIds: [],
    callJev: async () => {
      throw new Error("down");
    },
    callModel: async () => ({ choices: [{ message: { content: "خراب" } }] }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.layer, "rules");
  assert.equal(result.hypotheses.length, 0);
});

test("JSON قبلی حلقه بدون فراخوانی تازه لایهٔ deepseek است", async () => {
  let calls = 0;
  const hypothesis: Hypothesis = {
    id: "http_5xx",
    rank: 1,
    cause: "۵xx",
    confidence: 0.4,
    evidenceIds: ["ev_1"],
    kind: "observed",
    remedies: ["restart"],
    remedyText: ["ری‌استارت"],
  };
  const result = await decideIncident({
    decisionModel: "typesafe/jev-1.14",
    primaryModel: "deepseek-v4.1-flash",
    summary,
    remedies: [RESTART_REMEDY],
    evidenceIds: ["ev_1"],
    loop: { ok: true, hypotheses: [hypothesis], selectedRemedy: "restart", remedySource: "llm" },
    callJev: async () => {
      throw new Error("down");
    },
    callModel: async () => {
      calls += 1;
      return jsonChoice("oom");
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.layer, "deepseek");
  assert.equal(result.hypotheses[0]?.id, "http_5xx");
});

test("detector استنتاجی observed نمی‌شود", async () => {
  const result = await decideIncident({
    decisionModel: "typesafe/jev-1.14",
    summary,
    remedies: [RESTART_REMEDY],
    evidenceIds: ["ev_seed"],
    detect: () => ({
      hypotheses: [{
        id: "memory_leak",
        rank: 1,
        cause: "رشد حافظه",
        confidence: 0.3,
        evidenceIds: ["ev_mem"],
        kind: "inferred",
        remedies: ["restart"],
        remedyText: ["ری‌استارت"],
      }],
      evidence: [],
    }),
    callJev: async () => jev("memory_leak"),
  });
  assert.equal(result.ok, true);
  assert.equal(result.hypotheses[0]?.kind, "inferred");
});

test("متن آرایه‌ای JSON و مدل جایگزین خالی خوانده می‌شود", async () => {
  const seen: string[] = [];
  const result = await decideIncident({
    decisionModel: "typesafe/jev-1.14",
    primaryModel: "deepseek-v4.1-flash",
    fallbackModel: "",
    summary,
    remedies: [RESTART_REMEDY],
    evidenceIds: ["ev_1"],
    logs: [{ ts: null, level: "error", message: "status 500" }],
    probe: { url: "https://agate-liara.liara.run/", samples: [{ status: 500, latencyMs: 10 }], ok: false, p50: 10 },
    callJev: async () => { throw new Error("down"); },
    callModel: async (model) => {
      seen.push(model);
      if (model !== "gpt-4.1-mini") return { choices: [{ message: { content: [{ type: "text", text: "نه" }] } }] };
      return { choices: [{ message: { content: [{ type: "text", text: JSON.stringify({ hypotheses: [{ id: "http_5xx", confidence: 0.7 }], remedy: "restart" }) }] } }] };
    },
  });
  assert.deepEqual(seen, ["deepseek-v4.1-flash", "deepseek-v4.1-flash", "gpt-4.1-mini"]);
  assert.equal(result.layer, "fallback");
  assert.equal(result.hypotheses[0]?.id, "http_5xx");
});

test("شواهد leak با متریک خالی و kill، crash_loop را رد و memory_leak را نگه می‌دارد", async () => {
  const leakLine = "[BUG] leak active heapMB=48.2 sinkItems=6";
  const logs = [{ ts: "2026-10-23T11:40:00.000Z", level: "stdout", message: leakLine }];
  const events = [
    { ts: "1792746452", type: "kill", message: "kill" },
    { ts: "1792746452", type: "die", message: "die" },
    { ts: "1792747802", type: "oom", message: "OOMKilled" },
  ];
  const summary = `${"noise ".repeat(400)}\n${leakLine}`;
  let state = "";
  let memoryCriteria = "";
  const rejected = await decideIncident({
    decisionModel: "typesafe/jev-1.14",
    primaryModel: "deepseek-v4.1-flash",
    fallbackModel: "gpt-4.1-mini",
    summary,
    remedies: [RESTART_REMEDY],
    evidenceIds: ["ev_1"],
    logs,
    events,
    memory: null,
    callJev: async (body) => {
      const questions = body["questions"] as { hypothesis?: { criteria?: Record<string, string> } };
      state = String((body["state"] as { text?: string }).text ?? "");
      memoryCriteria = questions.hypothesis?.criteria?.memory_leak ?? "";
      return jev("crash_loop");
    },
    callModel: async () => jsonChoice("crash_loop"),
  });
  assert.equal(memoryCriteria, "حافظه بالا می‌رود یا لاگ heap/leak یا OOM دیده می‌شود، حتی اگر متریک حافظه خالی باشد");
  assert.match(state, /\[BUG\] leak active heapMB=48\.2/);
  assert.match(state, /برچسب رویداد: kill\/die \| kill\/die \| OOMKilled/);
  assert.ok(state.indexOf(leakLine) < 1500);
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason ?? "", /crash_loop/);

  const accepted = await decideIncident({
    decisionModel: "typesafe/jev-1.14",
    summary,
    remedies: [RESTART_REMEDY],
    evidenceIds: ["ev_1"],
    logs,
    events,
    memory: null,
    callJev: async () => jev("memory_leak"),
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.layer, "jev");
  assert.equal(accepted.hypotheses[0]?.id, "memory_leak");
  assert.equal(accepted.hypotheses[0]?.kind, "observed");
});

test("baseline سالم و ENV_UPDATE و 5xx فقط rollback را به Jev می‌دهد", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "agate-rollback-jev-"));
  const now = Date.now();
  try {
    saveEnvBaseline("agate-liara", [{ key: "FEATURE_FLAG", value: "off" }], {
      stateDir,
      at: new Date(now - 4 * 60_000).toISOString(),
    });
    let remedyIds: string[] = [];
    let round = 0;
    const run = await runDiagnosis("agate-liara", "صفحه خطای سرور می‌دهد", {
      investigateMode: "agentic",
      incidentAt: new Date(now).toISOString(),
      stateDir,
      captureBaseline: false,
      auditEntries: [],
      releases: [{ _id: "rel_env", type: "ENV_UPDATE", createdAt: new Date(now - 2 * 60_000).toISOString() }],
      logs: [],
      events: [],
      cpu: null,
      memory: null,
      plan: null,
      agentic: {
        seed: false,
        executeTool: async () => ({
          summary: "status 500",
          evidence: {
            id: "x",
            source: "probe",
            observation: "status 500",
            available: true,
            collectedAt: new Date(now).toISOString(),
          },
          probe: {
            url: "https://agate-liara.liara.run/",
            samples: [{ status: 500, latencyMs: 40 }],
            ok: false,
            p50: 40,
          },
        }),
        callLlm: async () => {
          round += 1;
          if (round === 1) {
            return {
              choices: [{
                message: {
                  content: null,
                  tool_calls: [{ id: "p", type: "function", function: { name: "http_probe", arguments: JSON.stringify({ reason: "خطا", path: "/" }) } }],
                },
              }],
            };
          }
          return { choices: [{ message: { content: JSON.stringify({ hypotheses: [{ id: "http_5xx", rank: 1, confidence: 0.7, evidenceIds: ["ev_1"] }], remedy: "restart" }) } }] };
        },
        callJev: async (body) => {
          const questions = body["questions"] as { remedy?: { criteria?: Record<string, string> } };
          remedyIds = Object.keys(questions.remedy?.criteria ?? {});
          return {
            answers: {
              hypothesis: { choice: "http_5xx", probabilities: { http_5xx: 0.9 }, confidence: 0.8 },
              remedy: { choice: "rollback_last_env_change" },
            },
            usage: { cost: 0.00003 },
          };
        },
      },
    });
    assert.deepEqual(remedyIds, ["rollback_last_env_change"]);
    assert.equal(run.rollbackAvailable, true);
    assert.equal(run.selectedRemedy, "rollback_last_env_change");
    assert.equal(run.report.investigation?.decisionLayer, "jev");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
