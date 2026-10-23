/**
 * ارزیابی فقط‌خواندنی چهار سناریوی دمو با تنظیم فعلی LLM.
 * .env را عوض نمی‌کند و API نوشتنی لیارا را صدا نمی‌زند.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../src/config.js";
import { runDiagnosis } from "../src/tools/composite.js";

const app = "agate-liara";
const origin = `https://${app}.liara.run`;

const scenarios = [
  { id: "leak", mode: "leak", symptom: "مصرف حافظه بالا رفته و سرویس ممکن است ری‌استارت شود", expect: ["memory_leak", "oom"] },
  { id: "slow", mode: "slow", symptom: "صفحهٔ اصلی کند شده است", expect: ["slow_responses"] },
  { id: "error500", mode: "error500", symptom: "صفحهٔ اصلی یا API خطای سرور می‌دهد", expect: ["http_5xx"] },
  { id: "blind", mode: "error500", symptom: "کاربران خطا می‌بینند", expect: ["http_5xx"] },
] as const;

function adminKey(): string {
  const fromEnv = process.env.ADMIN_KEY ?? "";
  const latin1 = [...fromEnv].every((char) => char.charCodeAt(0) <= 255);
  if (fromEnv && latin1) return fromEnv;
  const baseline = JSON.parse(readFileSync(path.join(config.stateDir, "env-baseline-agate-liara.json"), "utf8")) as {
    env?: { key?: string; value?: string }[];
  };
  return baseline.env?.find((item) => item.key === "ADMIN_KEY")?.value ?? "";
}

async function setMode(mode: string): Promise<void> {
  const key = adminKey();
  if (!key) throw new Error("ADMIN_KEY برای دمو در دسترس نیست.");
  const res = await fetch(`${origin}/__agate-admin`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-key": key },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) throw new Error(`تغییر حالت دمو ناموفق بود: HTTP ${res.status}`);
}

async function runScenario(scenario: (typeof scenarios)[number]) {
  const started = Date.now();
  try {
    let leakTimer: ReturnType<typeof setTimeout> | undefined;
    if (scenario.mode === "leak") {
      await setMode("leak");
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      leakTimer = setTimeout(() => { void setMode("off"); }, 10_000);
    } else {
      await setMode(scenario.mode);
    }
    const run = await runDiagnosis(app, scenario.symptom, { captureBaseline: false });
    if (leakTimer) clearTimeout(leakTimer);
    const ids = run.report.hypotheses.map((item) => item.id);
    const text = `${run.text}\n${JSON.stringify(run.report.investigation ?? {})}`;
    const layer = run.report.investigation?.decisionLayer ?? run.report.investigation?.mode ?? "fixed";
    return {
      scenario: scenario.id,
      hypotheses: ids,
      remedy: run.selectedRemedy,
      accurate: ids.some((id) => (scenario.expect as readonly string[]).includes(id)),
      layer,
      rulesFallback: layer === "rules" || layer === "fixed",
      steps: run.report.investigation?.steps.length ?? 0,
      elapsedMs: run.report.investigation?.elapsedMs ?? Date.now() - started,
      modelMs: run.report.investigation?.modelMs ?? null,
      toolMs: run.report.investigation?.toolMs ?? null,
      cost: run.report.investigation?.cost ?? null,
      fallback: run.report.investigation?.fallbackReason ?? null,
      blindClean: !/bugMode|BUG_MODE/i.test(text),
    };
  } finally {
    await setMode("off");
  }
}

async function main(): Promise<void> {
  if (!config.llmEnabled) throw new Error("LLM برای ارزیابی فعال نیست.");
  const rows = [];
  for (const scenario of scenarios) {
    const row = await runScenario(scenario);
    rows.push(row);
    console.log(JSON.stringify(row));
  }
  const judged = rows.filter((row) => row.accurate && !row.rulesFallback);
  const mean = rows.reduce((sum, row) => sum + row.elapsedMs, 0) / rows.length;
  const keepAgentic = judged.length >= 3 && mean < 45_000;
  const out = path.join(config.stateDir, "eval-investigate.json");
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), model: config.llmModel, decision: config.llmDecisionModel, meanMs: mean, judged: judged.length, keepAgentic, rows }, null, 2));
  console.log(JSON.stringify({ meanMs: Math.round(mean), judged: judged.length, keepAgentic }));
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  const secret = config.llmApiKey || "\u0000";
  console.error(message.split(secret).join("••••"));
  process.exitCode = 1;
});
