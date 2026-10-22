/**
 * تست صداقت تشخیص: ورودی LLM نباید BUG_MODE یا بدنهٔ /health را داشته باشد.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLlmPrompt, rankWithLlm, stripBugMode } from "../src/diagnose/llm.js";
import type { Evidence, Hypothesis } from "../src/types.js";

const evidence: Evidence[] = [
  {
    id: "ev_1",
    source: "env",
    observation: "BUG_MODE=error500؛ همهٔ متغیرهای لازم تعریف شده‌اند.",
    available: true,
    collectedAt: "2026-10-22T19:00:00.000Z",
  },
  {
    id: "ev_2",
    source: "probe",
    observation: "زمان پاسخ /: p50=2699ms",
    available: true,
    collectedAt: "2026-10-22T19:00:00.000Z",
  },
];

const hypotheses: Hypothesis[] = [
  {
    id: "slow_responses",
    rank: 1,
    cause: "کندی پاسخ (p50 بالای ۱۵۰۰ms)",
    confidence: 0.6,
    evidenceIds: ["ev_2"],
    kind: "observed",
    remedies: ["code_fix", "restart"],
    remedyText: ["بررسی مسیرهای کند", "ری‌استارت"],
  },
];

test("BUG_MODE و مقدار حالت از پرامپت LLM حذف می‌شوند", () => {
  const prompt = buildLlmPrompt({
    app: "agate-liara",
    symptom: "سایت مشکل دارد؛ BUG_MODE=error500 را فعال کردم و bugMode: \"error500\" است.",
    hypotheses,
    evidence,
  });
  const all = `${prompt.system}\n${prompt.user}`;
  assert.doesNotMatch(all, /BUG_MODE|bugMode/i);
  assert.doesNotMatch(all, /error500/i);
  assert.match(prompt.user, /کندی پاسخ/);
  assert.match(prompt.user, /p50=2699ms/);
});

test("stripBugMode متن عادی را دست‌نخورده نگه می‌دارد", () => {
  assert.equal(stripBugMode("سایت کند است و خطا می‌دهد"), "سایت کند است و خطا می‌دهد");
  assert.equal(stripBugMode("BUG_MODE=leak"), "");
});

test("پرامپت فقط اجزای مجاز را دارد", () => {
  const prompt = buildLlmPrompt({ app: "agate-liara", hypotheses, evidence });
  assert.match(prompt.system, /فقط از شواهد داده‌شده استفاده کن/);
  assert.match(prompt.user, /شواهد:/);
  assert.match(prompt.user, /JSON خروجی:/);
});

test("بدون علت قانونی، LLM فراخوانی نمی‌شود", async () => {
  const result = await rankWithLlm({ app: "agate-liara", hypotheses: [], evidence: [] });
  assert.equal(result.usedLlm, false);
  assert.match(result.note ?? "", /LLM فراخوانی نشد/);
});
