/**
 * مقایسهٔ فقط‌خواندنی حلقهٔ agentic روی سناریوهای دمو.
 * .env را تغییر نمی‌دهد و هیچ API نوشتنی لیارا را صدا نمی‌زند.
 * حالت باگ فقط از پنل خود دمو عوض می‌شود و در پایان به off برمی‌گردد.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../src/config.js";
import { runDiagnosis } from "../src/tools/composite.js";

const app = "agate-liara";
const origin = `https://${app}.liara.run`;

interface Target {
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface Scenario {
  id: "leak" | "slow" | "error500" | "blind";
  mode: "leak" | "slow" | "error500";
  symptom: string;
  expect: string[];
}

const scenarios: Scenario[] = [
  { id: "leak", mode: "leak", symptom: "مصرف حافظه بالا رفته و سرویس ممکن است ری‌استارت شود", expect: ["memory_leak", "oom"] },
  { id: "slow", mode: "slow", symptom: "صفحهٔ اصلی کند شده است", expect: ["slow_responses"] },
  { id: "error500", mode: "error500", symptom: "صفحهٔ اصلی یا API خطای سرور می‌دهد", expect: ["http_5xx"] },
  { id: "blind", mode: "error500", symptom: "کاربران خطا می‌بینند", expect: ["http_5xx"] },
];

async function setMode(mode: string): Promise<void> {
  const key = process.env.ADMIN_KEY ?? "";
  if (!key) throw new Error("ADMIN_KEY تنظیم نشده است.");
  const res = await fetch(`${origin}/__agate-admin`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-key": key },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) throw new Error(`تغییر حالت دمو ناموفق بود: HTTP ${res.status}`);
}

async function callTarget(target: Target, body: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${target.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${target.apiKey}`,
      },
      body: JSON.stringify({ ...body, model: target.model }),
      signal: controller.signal,
    });
    const text = await res.text();
    const safe = text.split(target.apiKey).join("••••");
    if (!res.ok) throw new Error(`HTTP ${res.status} ${safe.slice(0, 240)}`);
    return JSON.parse(safe) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

async function runScenario(target: Target, scenario: Scenario) {
  const started = Date.now();
  try {
    if (scenario.mode === "leak") {
      await setMode("leak");
      await new Promise((resolve) => setTimeout(resolve, 18_000));
      await setMode("off");
    } else {
      await setMode(scenario.mode);
    }
    const run = await runDiagnosis(app, scenario.symptom, {
      investigateMode: "agentic",
      captureBaseline: false,
      agentic: {
        model: target.model,
        callLlm: (body, timeoutMs) => callTarget(target, body, timeoutMs),
      },
    });
    const ids = run.report.hypotheses.map((item) => item.id);
    const text = `${run.text}\n${JSON.stringify(run.report.investigation ?? {})}`;
    return {
      scenario: scenario.id,
      model: target.model,
      host: hostOf(target.baseUrl),
      accurate: ids.some((id) => scenario.expect.includes(id)),
      hypotheses: ids,
      confidence: run.report.hypotheses.map((item) => Number(item.confidence.toFixed(2))),
      remedy: run.selectedRemedy,
      steps: run.report.investigation?.steps.length ?? 0,
      tools: run.report.investigation?.steps.map((step) => step.tool) ?? [],
      elapsedMs: Date.now() - started,
      loopMs: run.report.investigation?.elapsedMs ?? null,
      fallback: run.report.investigation?.fallbackReason ?? null,
      mode: run.report.investigation?.mode ?? "fixed",
      blindClean: !/bugMode|BUG_MODE/i.test(text),
    };
  } finally {
    await setMode("off");
  }
}

async function main(): Promise<void> {
  const gapKey = process.env.GAPGPT_API_KEY ?? "";
  if (!config.llmEnabled || !gapKey || !(process.env.ADMIN_KEY ?? "")) {
    throw new Error("مقایسه به LLM و GAPGPT_API_KEY و ADMIN_KEY نیاز دارد؛ مقدارها چاپ نمی‌شوند.");
  }
  const targets: Target[] = [
    { label: "box", baseUrl: config.llmBaseUrl, apiKey: config.llmApiKey, model: "gpt-5-mini" },
    { label: "gap", baseUrl: "https://api.gapgpt.app/v1", apiKey: gapKey, model: "deepseek-v4.1-flash" },
  ];
  const rows = [];
  for (const target of targets) {
    let active = target;
    for (const scenario of scenarios) {
      let row = await runScenario(active, scenario);
      if (active.label === "gap" && active.model === "deepseek-v4.1-flash" && row.steps === 0) {
        active = { ...target, model: "gpt-4.1-mini" };
        row = await runScenario(active, scenario);
        row = { ...row, fallback: `deepseek-v4.1-flash ابزار صدا نزد؛ تکرار با gpt-4.1-mini. ${row.fallback ?? ""}`.trim() };
      }
      rows.push(row);
      console.log(JSON.stringify({ ...row, host: row.host }));
    }
  }
  const out = path.join(config.stateDir, "investigate-compare.json");
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), rows }, null, 2));
  console.log(`wrote ${rows.length} rows`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message.split(process.env.GAPGPT_API_KEY ?? "\u0000").join("••••").split(config.llmApiKey || "\u0000").join("••••"));
  process.exitCode = 1;
});
