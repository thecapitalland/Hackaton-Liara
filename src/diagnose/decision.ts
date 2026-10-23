/**
 * لایهٔ تصمیم diagnose.
 * Jev از /systemone، بعد JSON مدل بررسی با یک repair، بعد مدل جایگزین، بعد قواعد.
 * اگر مدل تصمیم خالی باشد، فراخوان‌کننده رفتار قبلی حلقه را نگه می‌دارد.
 */
import { z } from "zod";
import { config } from "../config.js";
import type { Hypothesis, RemedyKind } from "../types.js";
import { detectCauses, DETECTOR_IDS, INJECTION_CONFIDENCE_CAP } from "./detectors.js";
import { UNSUPPORTED_CONFIDENCE_CAP, contentText, eventLabel, summarizeForModel } from "./agentic.js";
import type { RemedyOption } from "./llm.js";

const DETECTOR_CRITERIA: Record<string, string> = {
  memory_leak: "حافظه بالا می‌رود یا لاگ heap/leak یا OOM دیده می‌شود، حتی اگر متریک حافظه خالی باشد",
  oom: "تمام‌شدن حافظه یا رویداد OOM",
  http_5xx: "پاسخ ۵xx. تغییر env درست قبل از ۵xx همین علت با rollback است",
  missing_env: "متغیر محیطی لازم موجود نیست",
  crash_loop: "ری‌استارت یا کرش پشت‌سرهم",
  cpu_throttle: "اشباع پردازنده",
  slow_responses: "p50 بالای ۱۵۰۰ میلی‌ثانیه؛ معلوم بودن CPU لازم نیست",
};

const conclusionSchema = z.object({
  hypotheses: z.array(z.object({
    id: z.string(),
    confidence: z.number().min(0).max(1).optional(),
    evidenceIds: z.array(z.string()).optional(),
  })).min(1).max(3),
  remedy: z.string().optional(),
});

export interface DecisionOutcome {
  ok: boolean;
  layer: "jev" | "deepseek" | "fallback" | "rules";
  model?: string;
  hypotheses: Hypothesis[];
  selectedRemedy?: RemedyKind;
  remedySource: "llm" | "rules";
  probabilities?: Record<string, number>;
  confidence?: number;
  cost?: number;
  reason?: string;
}

export interface DecideArgs {
  decisionModel?: string;
  primaryModel?: string;
  fallbackModel?: string;
  summary: string;
  remedies: RemedyOption[];
  evidenceIds: string[];
  logs?: import("../types.js").LogLine[];
  events?: import("../types.js").EventItem[];
  cpu?: import("../types.js").Series | null;
  memory?: import("../types.js").Series | null;
  probe?: import("../types.js").ProbeResult | null;
  detect?: typeof detectCauses;
  callJev?: (body: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;
  callModel?: (model: string, messages: { role: string; content: string }[], timeoutMs: number) => Promise<unknown>;
  timeoutMs?: number;
  /** نتیجهٔ JSON حلقهٔ deepseek، اگر قبلاً ساخته شده باشد. */
  loop?: { ok: boolean; hypotheses: Hypothesis[]; selectedRemedy?: RemedyKind; remedySource: "llm" | "rules" };
}

export async function decideIncident(args: DecideArgs): Promise<DecisionOutcome> {
  const decisionModel = args.decisionModel ?? config.llmDecisionModel;
  const primary = args.primaryModel ?? config.llmModel;
  const fallback = args.fallbackModel || config.llmModelFallback || "gpt-4.1-mini";
  const timeoutMs = args.timeoutMs ?? config.llmTimeoutHintMs;
  if (!decisionModel && !args.callJev) {
    return empty("rules", "مدل تصمیم تنظیم نشده است.");
  }

  const jevFailure = await tryJev(args, decisionModel, timeoutMs);
  if (jevFailure.ok) return jevFailure;
  const loopId = args.loop?.hypotheses[0]?.id;
  const loopBlocked = loopId === "crash_loop" && memorySignal(args) && !hasNonOomRestart(args);
  if (args.loop?.ok && args.loop.hypotheses.length && !loopBlocked) {
    return {
      ok: true,
      layer: "deepseek",
      model: primary,
      hypotheses: args.loop.hypotheses,
      selectedRemedy: args.loop.selectedRemedy,
      remedySource: args.loop.remedySource,
      reason: jevFailure.reason,
    };
  }

  const deepseek = await tryJsonModel(args, primary, "deepseek", timeoutMs, true);
  if (deepseek.ok) return deepseek;

  if (fallback && fallback !== primary) {
    const alternate = await tryJsonModel(args, fallback, "fallback", timeoutMs, false);
    if (alternate.ok) return alternate;
  }

  return empty("rules", [jevFailure.reason, deepseek.reason].filter(Boolean).join(" "));
}

function empty(layer: DecisionOutcome["layer"], reason: string): DecisionOutcome {
  return { ok: false, layer, hypotheses: [], remedySource: "rules", reason };
}

async function tryJev(args: DecideArgs, model: string, timeoutMs: number): Promise<DecisionOutcome> {
  if (!model && !args.callJev) return empty("jev", "مدل Jev خالی است.");
  const body = jevBody(model || "typesafe/jev-1.14", args.summary, args.remedies, args);
  try {
    const response = await (args.callJev ?? defaultCallJev)(body, timeoutMs);
    const parsed = readJev(response);
    if (!parsed) return empty("jev", "پاسخ Jev قابل خواندن نبود.");
    const checked = acceptChoice(args, parsed.hypothesis, parsed.remedy, parsed.confidence, "jev", model);
    if (!checked.ok) return { ...checked, probabilities: parsed.probabilities, cost: parsed.cost, model };
    return { ...checked, probabilities: parsed.probabilities, confidence: parsed.confidence, cost: parsed.cost, model };
  } catch (err) {
    const message = err instanceof Error && err.name === "AbortError" ? "timeout" : "خطا";
    return empty("jev", `Jev ناموفق بود (${message}).`);
  }
}

async function tryJsonModel(
  args: DecideArgs,
  model: string,
  layer: "deepseek" | "fallback",
  timeoutMs: number,
  repair: boolean,
): Promise<DecisionOutcome> {
  if (!model) return empty(layer, "مدل JSON خالی است.");
  const ask = async (extra: string) => (args.callModel ?? defaultCallModel)(model, [
    { role: "system", content: jsonInstruction(args.remedies) },
    { role: "user", content: `${summarizeForModel(args.summary)}\n${extra}` },
  ], timeoutMs);
  try {
    const first = readJsonChoice(await ask("فقط JSON نهایی را برگردان."));
    const second = first ? null : repair ? readJsonChoice(await ask("JSON قبلی نامعتبر بود. فقط یک JSON اصلاح‌شده برگردان.")) : null;
    const choice = first ?? second;
    if (!choice) return empty(layer, `JSON مدل ${model} نامعتبر بود.`);
    const checked = acceptChoice(args, choice.id, choice.remedy, choice.confidence, layer, model);
    return checked;
  } catch (err) {
    const message = err instanceof Error && err.name === "AbortError" ? "timeout" : "خطا";
    return empty(layer, `${model} ناموفق بود (${message}).`);
  }
}

function acceptChoice(
  args: DecideArgs,
  hypothesisId: string,
  remedyId: string | undefined,
  confidence: number | undefined,
  layer: DecisionOutcome["layer"],
  model: string,
): DecisionOutcome {
  if (!DETECTOR_IDS.includes(hypothesisId)) {
    return empty(layer, `فرضیهٔ ${hypothesisId} خارج از allowlist است.`);
  }
  const allowed = new Set(args.remedies.map((remedy) => remedy.id));
  if (remedyId && !allowed.has(remedyId as RemedyKind)) {
    return empty(layer, `راهکار ${remedyId} خارج از allowlist است.`);
  }
  if (hypothesisId === "crash_loop" && memorySignal(args) && !hasNonOomRestart(args)) {
    return empty(layer, "با نشانهٔ OOM یا leak، crash_loop فقط وقتی restart بدون OOM هم باشد مجاز است.");
  }
  const detected = (args.detect ?? detectCauses)({
    app: "decision",
    logs: args.logs ?? [],
    events: args.events ?? [],
    cpu: args.cpu ?? null,
    memory: args.memory ?? null,
    probe: args.probe ?? null,
    env: null,
    plan: null,
    collectedAt: new Date().toISOString(),
  });
  const detector = detected.hypotheses.find((item) => item.id === hypothesisId);
  const cited = (args.evidenceIds ?? []).filter(Boolean);
  const supported = detector?.kind === "observed";
  let score = typeof confidence === "number" ? confidence : detector?.confidence ?? UNSUPPORTED_CONFIDENCE_CAP;
  if (detector) score = Math.min(score, detector.confidence);
  if (!supported) score = Math.min(score, UNSUPPORTED_CONFIDENCE_CAP);
  if ((args.logs ?? []).some((line) => line.injectionSuspected)) score = Math.min(score, INJECTION_CONFIDENCE_CAP);
  const selected = remedyId && allowed.has(remedyId as RemedyKind) ? remedyId as RemedyKind : args.remedies[0]?.id;
  return {
    ok: true,
    layer,
    model,
    remedySource: remedyId && allowed.has(remedyId as RemedyKind) ? "llm" : "rules",
    selectedRemedy: selected,
    hypotheses: [{
      id: hypothesisId,
      rank: 1,
      cause: DETECTOR_CRITERIA[hypothesisId] ?? hypothesisId,
      confidence: score,
      evidenceIds: cited.slice(0, 3),
      kind: supported ? "observed" : "inferred",
      remedies: selected ? [selected] : ["restart"],
      remedyText: [args.remedies.find((remedy) => remedy.id === selected)?.labelFa ?? "ری‌استارت سرویس"],
    }],
  };
}

function memorySignal(args: DecideArgs): boolean {
  const blob = [
    args.summary,
    ...(args.logs ?? []).map((line) => line.message),
    ...(args.events ?? []).map((event) => `${event.type} ${event.message}`),
  ].join("\n");
  return /heap|\[BUG\]\s*leak|heap out of memory|OOMKilled/i.test(blob);
}

function hasNonOomRestart(args: DecideArgs): boolean {
  return (args.events ?? []).some((event) => {
    const blob = `${event.type} ${event.message}`;
    return /\brestart\b/i.test(blob) && !/OOMKilled|heap out of memory|out of memory|\boom\b/i.test(blob);
  });
}

function jevState(summary: string, args: Pick<DecideArgs, "logs" | "events">): string {
  const logs = (args.logs ?? [])
    .map((line) => line.message)
    .filter((message) => /heap|\[BUG\]\s*leak|heap out of memory|OOMKilled/i.test(message));
  const labels = (args.events ?? []).map((event) => eventLabel(event));
  const preface = [
    logs.length ? `لاگ حافظه: ${logs.join(" | ")}` : "",
    labels.length ? `برچسب رویداد: ${labels.join(" | ")}` : "",
  ].filter(Boolean).join("\n");
  return summarizeForModel(preface ? `${preface}\n${summary}` : summary);
}

function jevBody(model: string, summary: string, remedies: RemedyOption[], args: Pick<DecideArgs, "logs" | "events">): Record<string, unknown> {
  return {
    model,
    state: { text: jevState(summary, args) },
    questions: {
      hypothesis: {
        type: "choice",
        instructions: "یک علت را فقط از روی شواهد state انتخاب کن. تغییر env درست قبل از 5xx یعنی http_5xx و remedy باید rollback باشد، فقط وقتی خود شواهد آن تغییر را نشان می‌دهند.",
        criteria: Object.fromEntries(DETECTOR_IDS.map((id) => [id, DETECTOR_CRITERIA[id] ?? id])),
      },
      remedy: {
        type: "choice",
        instructions: "فقط یک راهکار مجاز را انتخاب کن.",
        criteria: Object.fromEntries(remedies.map((remedy) => [remedy.id, remedy.labelFa])),
      },
    },
  };
}

function readJev(response: unknown): { hypothesis: string; remedy?: string; confidence?: number; probabilities?: Record<string, number>; cost?: number } | null {
  if (!response || typeof response !== "object") return null;
  const body = response as { answers?: Record<string, { choice?: unknown; probabilities?: unknown; confidence?: unknown }>; usage?: { cost?: unknown } };
  const hypothesis = body.answers?.hypothesis?.choice;
  if (typeof hypothesis !== "string" || !hypothesis) return null;
  const remedy = body.answers?.remedy?.choice;
  const confidence = body.answers?.hypothesis?.confidence;
  return {
    hypothesis,
    remedy: typeof remedy === "string" ? remedy : undefined,
    confidence: typeof confidence === "number" ? confidence : undefined,
    probabilities: numberMap(body.answers?.hypothesis?.probabilities),
    cost: typeof body.usage?.cost === "number" ? body.usage.cost : undefined,
  };
}

function readJsonChoice(response: unknown): { id: string; remedy?: string; confidence?: number } | null {
  const content = contentOf(response);
  if (!content) return null;
  const parsed = extractJson(content);
  const safe = conclusionSchema.safeParse(parsed);
  if (!safe.success) return null;
  const first = safe.data.hypotheses[0];
  if (!first) return null;
  return { id: first.id, remedy: safe.data.remedy, confidence: first.confidence };
}

function contentOf(response: unknown): string {
  if (!response || typeof response !== "object") return "";
  const message = (response as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
  return contentText(message);
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function numberMap(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "number") out[key] = item;
  }
  return Object.keys(out).length ? out : undefined;
}

function jsonInstruction(remedies: RemedyOption[]): string {
  return [
    "فقط JSON برگردان.",
    `hypotheses[].id یکی از ${DETECTOR_IDS.join("، ")} است.`,
    `remedy یکی از ${remedies.map((remedy) => remedy.id).join("، ") || "restart"} است.`,
    "تغییر env درست قبل از 5xx یعنی http_5xx و rollback، فقط اگر شواهد همان تغییر را نشان دهند.",
  ].join(" ");
}

async function defaultCallJev(body: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  return postJson("/systemone", body, timeoutMs);
}

async function defaultCallModel(model: string, messages: { role: string; content: string }[], timeoutMs: number): Promise<unknown> {
  return postJson("/chat/completions", { model, messages }, timeoutMs);
}

async function postJson(pathname: string, body: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.llmBaseUrl.replace(/\/+$/, "")}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.llmApiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
