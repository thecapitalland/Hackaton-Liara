/**
 * تست‌های رگرسیون اقدام درمانی و پنجرهٔ شواهد.
 *
 * - رویداد قدیمی‌تر از ۱۰ دقیقه نباید در شواهد/تشخیص ظاهر شود.
 * - بدون تغییر env قابل‌بازگشت، راهکار پیشنهادی restart است.
 * - با تغییر env دقیق در پنجره، rollback_last_env_change انتخاب می‌شود.
 * - LLM فقط از فهرست راهکارهای مجاز می‌تواند انتخاب کند.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  RESTART_REMEDY,
  ROLLBACK_ENV_REMEDY,
  buildLlmPrompt,
  rankWithLlm,
} from "../src/diagnose/llm.js";
import { filterEventsToWindow } from "../src/diagnose/window.js";
import type { EnvChangeCandidate } from "../src/env-history.js";
import { runDiagnosis } from "../src/tools/composite.js";
import type { Evidence, Hypothesis, ProbeResult } from "../src/types.js";

const app = "agate-liara";

function probe500(): ProbeResult {
  return {
    url: `https://${app}.liara.run/`,
    samples: [
      { status: 500, latencyMs: 100 },
      { status: 500, latencyMs: 100 },
      { status: 500, latencyMs: 100 },
    ],
    ok: false,
    p50: 100,
  };
}

function probe200(): ProbeResult {
  return {
    url: `https://${app}.liara.run/`,
    samples: [
      { status: 200, latencyMs: 100 },
      { status: 200, latencyMs: 100 },
      { status: 200, latencyMs: 100 },
    ],
    ok: true,
    p50: 100,
  };
}

function hypothesis(): Hypothesis {
  return {
    id: "slow_responses",
    rank: 1,
    cause: "کندی پاسخ",
    confidence: 0.6,
    evidenceIds: ["ev_2"],
    kind: "observed",
    remedies: ["code_fix", "restart"],
    remedyText: ["بررسی مسیرهای کند", "ری‌استارت"],
  };
}

function evidence(): Evidence[] {
  return [
    {
      id: "ev_2",
      source: "probe",
      observation: "زمان پاسخ /: p50=2699ms",
      available: true,
      collectedAt: new Date().toISOString(),
    },
  ];
}

test("filterEventsToWindow رویداد قدیمی و بدون زمان را حذف می‌کند", () => {
  const now = new Date();
  const recent = new Date(now.getTime() - 60_000).toISOString();
  const old = new Date(now.getTime() - 20 * 60_000).toISOString();
  const filtered = filterEventsToWindow(
    [
      { ts: old, type: "oom", message: "old" },
      { ts: recent, type: "oom", message: "recent" },
      { ts: null, type: "kill", message: "undated" },
    ],
    now.toISOString(),
    10,
  );
  assert.deepEqual(filtered.items.map((e) => e.message), ["recent"]);
  assert.equal(filtered.dropped, 2);
  assert.equal(filtered.undated, 1);
});

test("پنجرهٔ شواهد به incidentAt لنگر می‌شود، نه زمان اجرای diagnose", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "agate-diagnosis-anchor-"));
  try {
    const incidentAt = new Date(Date.now() - 30 * 60_000);
    const withinIncidentWindow = new Date(incidentAt.getTime() - 60_000).toISOString();
    const olderThanIncidentWindow = new Date(incidentAt.getTime() - 20 * 60_000).toISOString();
    const run = await runDiagnosis(app, "OOM", {
      incidentAt: incidentAt.toISOString(),
      probe: probe200(),
      logs: [],
      events: [
        { ts: olderThanIncidentWindow, type: "oom", message: "too old for incident window" },
        { ts: withinIncidentWindow, type: "oom", message: "inside incident window" },
      ],
      cpu: null,
      memory: null,
      plan: null,
      envChange: null,
      eventWindowMinutes: 10,
      stateDir,
      llm: false,
    });

    const eventEvidence = run.report.evidence.filter((e) => e.source === "events");
    assert.equal(eventEvidence.length, 1);
    assert.match(eventEvidence[0]!.observation, /1 رویداد/);
    assert.doesNotMatch(eventEvidence[0]!.observation, /2 رویداد/);
    assert.match(run.text, /1 رویداد قدیمی‌تر از 10 دقیقه/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("diagnose رویداد قدیمی را از شواهد حذف می‌کند", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "agate-diagnosis-window-"));
  try {
    const recent = new Date(Date.now() - 60_000).toISOString();
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    const run = await runDiagnosis(app, "OOM", {
      probe: probe200(),
      logs: [],
      events: [
        { ts: old, type: "oom", message: "old out of memory" },
        { ts: recent, type: "oom", message: "recent out of memory" },
      ],
      cpu: null,
      memory: null,
      plan: null,
      envChange: null,
      eventWindowMinutes: 10,
      stateDir,
      llm: false,
    });

    const eventEvidence = run.report.evidence.filter((e) => e.source === "events");
    assert.equal(eventEvidence.length, 1);
    assert.match(eventEvidence[0]!.observation, /1 رویداد/);
    assert.doesNotMatch(eventEvidence[0]!.observation, /2 رویداد/);
    assert.match(run.text, /1 رویداد قدیمی‌تر از 10 دقیقه/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("بدون تغییر env قابل‌بازگشت، راهکار restart انتخاب می‌شود", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "agate-diagnosis-restart-"));
  try {
    const run = await runDiagnosis(app, "HTTP 500", {
      probe: probe500(),
      logs: [],
      events: [],
      cpu: null,
      memory: null,
      plan: null,
      envChange: null,
      stateDir,
      llm: false,
    });

    assert.equal(run.selectedRemedy, "restart");
    assert.equal(run.remedySource, "rules");
    assert.equal(run.rollbackAvailable, false);
    assert.equal(run.report.selectedRemedy, "restart");
    assert.equal(
      run.report.hypotheses.some((h) => h.remedies.includes("rollback_last_env_change")),
      false,
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("با تغییر env دقیق در پنجره، rollback_last_env_change انتخاب می‌شود", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "agate-diagnosis-rollback-"));
  try {
    const envChange: EnvChangeCandidate = {
      id: "env_test",
      at: new Date(Date.now() - 60_000).toISOString(),
      app,
      source: "journal",
      revertable: true,
      changes: [{ key: "FEATURE_FLAG", before: "off", after: "on" }],
      keys: ["FEATURE_FLAG"],
    };
    const run = await runDiagnosis(app, "HTTP 500", {
      probe: probe500(),
      logs: [],
      events: [],
      cpu: null,
      memory: null,
      plan: null,
      envChange,
      stateDir,
      llm: false,
    });

    assert.equal(run.selectedRemedy, "rollback_last_env_change");
    assert.equal(run.remedySource, "rules");
    assert.equal(run.rollbackAvailable, true);
    assert.equal(run.envChangeSource, "journal");
    assert.equal(run.report.selectedRemedy, "rollback_last_env_change");
    assert.equal(
      run.report.hypotheses.some((h) => h.remedies.includes("rollback_last_env_change")),
      true,
    );
    assert.match(run.text, /برگرداندن آخرین تغییر env/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("LLM فهرست راهکارهای مجاز را می‌بیند و می‌تواند rollback را انتخاب کند", async () => {
  const previous = {
    base: process.env.LLM_BASE_URL,
    key: process.env.LLM_API_KEY,
    model: process.env.LLM_MODEL,
  };
  const originalFetch = globalThis.fetch;
  try {
    process.env.LLM_BASE_URL = "https://llm.test/v1";
    process.env.LLM_API_KEY = "test-key";
    process.env.LLM_MODEL = "test-model";

    let requestBody = "";
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  hypotheses: [{ id: "slow_responses", rank: 1, confidence: 0.9 }],
                  remedy: "rollback_last_env_change",
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const prompt = buildLlmPrompt({
      app,
      hypotheses: [hypothesis()],
      evidence: evidence(),
      remedies: [ROLLBACK_ENV_REMEDY, RESTART_REMEDY],
    });
    assert.match(prompt.user, /rollback_last_env_change/);
    assert.match(prompt.user, /restart/);

    const result = await rankWithLlm({
      app,
      hypotheses: [hypothesis()],
      evidence: evidence(),
      remedies: [ROLLBACK_ENV_REMEDY, RESTART_REMEDY],
    });
    assert.equal(result.usedLlm, true);
    assert.equal(result.selectedRemedy, "rollback_last_env_change");
    assert.match(requestBody, /rollback_last_env_change/);
    assert.doesNotMatch(requestBody, /FEATURE_FLAG/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous.base === undefined) delete process.env.LLM_BASE_URL;
    else process.env.LLM_BASE_URL = previous.base;
    if (previous.key === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = previous.key;
    if (previous.model === undefined) delete process.env.LLM_MODEL;
    else process.env.LLM_MODEL = previous.model;
  }
});

test("راهکار خارج از فهرست مجاز LLM نادیده گرفته می‌شود", async () => {
  const previous = {
    base: process.env.LLM_BASE_URL,
    key: process.env.LLM_API_KEY,
    model: process.env.LLM_MODEL,
  };
  const originalFetch = globalThis.fetch;
  try {
    process.env.LLM_BASE_URL = "https://llm.test/v1";
    process.env.LLM_API_KEY = "test-key";
    process.env.LLM_MODEL = "test-model";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  hypotheses: [{ id: "slow_responses", rank: 1, confidence: 0.9 }],
                  remedy: "code_fix",
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await rankWithLlm({
      app,
      hypotheses: [hypothesis()],
      evidence: evidence(),
      remedies: [RESTART_REMEDY],
    });
    assert.equal(result.usedLlm, true);
    assert.equal(result.selectedRemedy, undefined);
    assert.match(result.note ?? "", /فهرست مجاز نبود/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous.base === undefined) delete process.env.LLM_BASE_URL;
    else process.env.LLM_BASE_URL = previous.base;
    if (previous.key === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = previous.key;
    if (previous.model === undefined) delete process.env.LLM_MODEL;
    else process.env.LLM_MODEL = previous.model;
  }
});
