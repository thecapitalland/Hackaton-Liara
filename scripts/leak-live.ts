/**
 * سناریوی زندهٔ leak: حافظه از metrics/summary، diagnose، سپس برگرداندن حالت به off.
 * مدل از همان مسیر محصول می‌رود. اگر resolver این فرایند loopback باشد، درخواست مدل ارسال نمی‌شود.
 * ری‌استارت اینجا اجرا نمی‌شود.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { config } from "../src/config.js";
import { assessSummaryMemory } from "../src/diagnose/summary-memory.js";
import { liaraGet } from "../src/liara/client.js";
import { EP } from "../src/liara/endpoints.js";
import { fetchPlanCatalog } from "../src/liara/plans.js";
import { runDiagnosis } from "../src/tools/composite.js";

const app = "agate-liara";
const origin = `https://${app}.liara.run`;

function adminKey(): string {
  const fromEnv = process.env["ADMIN_KEY"] ?? "";
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

async function planMB(): Promise<number | null> {
  const { data } = await liaraGet<Record<string, unknown>>(EP.getProject(app));
  const obj = (data?.["project"] ?? data ?? {}) as Record<string, unknown>;
  const planID = typeof obj["planID"] === "string" ? obj["planID"] : "";
  if (!planID) return null;
  const catalog = await fetchPlanCatalog();
  const ramGB = catalog.pairs.find((pair) => pair.planID === planID)?.ramGB;
  return typeof ramGB === "number" && ramGB > 0 ? ramGB * 1024 : null;
}

async function summaryLine(ram: number | null): Promise<string> {
  const { data } = await liaraGet<unknown>(EP.metricsSummary(app));
  return assessSummaryMemory(data, ram).line;
}

const ram = await planMB().catch(() => null);
console.log(`before ${await summaryLine(ram)}`);
const healthBefore = await fetch(`${origin}/health`).then((res) => res.json() as Promise<Record<string, unknown>>);
console.log(`health-before bugMode=${String(healthBefore["bugMode"])} memMB=${String(healthBefore["memMB"])} extMB=${String(healthBefore["extMB"])}`);

let offTimer: ReturnType<typeof setTimeout> | undefined;
try {
  await setMode("leak");
  await new Promise((resolve) => setTimeout(resolve, 8_000));
  console.log(`mid ${await summaryLine(ram)}`);
  offTimer = setTimeout(() => { void setMode("off"); }, 10_000);
  const started = Date.now();
  const run = await runDiagnosis(app, "مصرف حافظه بالا رفته است");
  const hypothesis = run.report.hypotheses[0];
  const memoryLine = run.text.split("\n").find((line) => line.includes("summary-memory")) ?? "";
  console.log(JSON.stringify({
    elapsedMs: Date.now() - started,
    id: hypothesis?.id ?? null,
    kind: hypothesis?.kind ?? null,
    remedy: run.selectedRemedy,
    layer: run.report.investigation?.decisionLayer ?? null,
    summaryMemory: memoryLine,
  }));
} finally {
  if (offTimer) clearTimeout(offTimer);
  await setMode("off");
  const health = await fetch(`${origin}/health`).then((res) => res.json() as Promise<Record<string, unknown>>);
  console.log(`health-after bugMode=${String(health["bugMode"])} memMB=${String(health["memMB"])} extMB=${String(health["extMB"])}`);
}
