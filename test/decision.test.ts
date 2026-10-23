/**
 * لایهٔ تصمیم: Jev، سپس JSON، سپس مدل جایگزین، سپس قواعد.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { decideIncident } from "../src/diagnose/decision.js";
import { RESTART_REMEDY } from "../src/diagnose/llm.js";
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
