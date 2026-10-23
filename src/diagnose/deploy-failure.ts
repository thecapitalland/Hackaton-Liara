/**
 * تشخیص خطای deploy با همان ترتیب Jev، سپس deepseek، سپس مدل جایگزین، سپس قواعد.
 * مدل فقط یک علت از فهرست بسته را انتخاب می‌کند. کارت تازه اینجا ساخته نمی‌شود
 * و هیچ POSTی از این فایل نمی‌رود.
 */
import { config } from "../config.js";
import { contentText, summarizeForModel } from "./agentic.js";
import { callChatEndpoint, callJevEndpoint } from "./decision.js";
import { redactSecrets } from "../redact.js";

export const DEPLOY_CAUSES = [
  "preflight_query",
  "preflight_auth",
  "preflight_provider",
  "request_rejected",
  "build_failed",
  "network_blocked",
  "disk_blocked",
  "health_unconfirmed",
  "outside_control",
] as const;

export type DeployCause = (typeof DEPLOY_CAUSES)[number];
export type DeployNext = "approval_card" | "explain_only";
export type DeployLayer = "jev" | "deepseek" | "fallback" | "rules";

export interface DeployProbeEvidence {
  name: string;
  status: number | null;
  error?: string;
}

export interface DeployEvidence {
  stage: "preflight" | "create_app" | "disk" | "network" | "release" | "build" | "deploy";
  error: string;
  probes?: DeployProbeEvidence[];
  releaseId?: string;
  releaseStatus?: string;
  buildLogTail?: string[];
  /** متن کارتِ از قبل ساخته‌شده. این تابع کارت جدید نمی‌سازد. */
  pendingCard?: string;
}

export interface DeployExplanation {
  text: string;
  cause: DeployCause;
  layer: DeployLayer;
  next: DeployNext;
}

const CAUSE_FA: Record<DeployCause, string> = {
  preflight_query: "بررسی خواندنی preflight رد شد چون شکل درخواست با API لیارا جور نیست. این با کارت تأیید نوشته نمی‌شود.",
  preflight_auth: "حساب یا دسترسی این بررسی را رد کرد. توکن چاپ نمی‌شود و از اینجا عوض نمی‌شود.",
  preflight_provider: "پاسخ لیارا یا شبکه در بررسی خواندنی نرسید. نوشتنی فرستاده نشد.",
  request_rejected: "لیارا ساخت اپ را رد کرد. درخواست دوباره خودکار فرستاده نمی‌شود.",
  build_failed: "انتشار یا بیلد به وضعیت آماده نرسید. انتشار دوباره خودکار انجام نمی‌شود.",
  network_blocked: "شبکهٔ خصوصی مانع ساخت شد. بدون تأیید شما شبکه‌ای ساخته نمی‌شود.",
  disk_blocked: "دیسک مانع انتشار شد. بدون تأیید شما دیسکی ساخته نمی‌شود.",
  health_unconfirmed: "انتشار ساخته شد اما پروب سلامت موفق نشد. انتشار دوباره خودکار انجام نمی‌شود.",
  outside_control: "این خطا از دست این ابزار خارج است. هیچ نوشتنی فرستاده نشد.",
};

export interface ExplainDeps {
  useModel?: boolean;
  callJev?: (body: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;
  callModel?: (model: string, messages: { role: string; content: string }[], timeoutMs: number) => Promise<unknown>;
  timeoutMs?: number;
}

export function classifyDeployFailure(evidence: DeployEvidence): DeployCause {
  const blob = [
    evidence.stage,
    evidence.error,
    ...(evidence.probes ?? []).map((probe) => `${probe.status ?? ""} ${probe.error ?? ""}`),
    evidence.releaseStatus ?? "",
  ].join("\n");
  if (evidence.stage === "preflight" || /preflight/i.test(blob)) {
    if (/401|403|توکن تنظیم نشده|AUTH_REQUIRED/.test(blob)) return "preflight_auth";
    if (/5\d\d|ECONN|ETIMEDOUT|fetch failed|API_UNAVAILABLE|network error|Service Unavailable/i.test(blob)) return "preflight_provider";
    return "preflight_query";
  }
  if (evidence.stage === "network") return "network_blocked";
  if (evidence.stage === "disk") return "disk_blocked";
  if (evidence.stage === "build" || evidence.stage === "release") return "build_failed";
  if (/پروب سلامت|سلامت موفق نشد/.test(blob)) return "health_unconfirmed";
  if (evidence.stage === "create_app") return "request_rejected";
  if (/401|403|توکن تنظیم نشده/.test(blob)) return "preflight_auth";
  if (/5\d\d|ECONN|ETIMEDOUT|Service Unavailable/i.test(blob)) return "preflight_provider";
  return "outside_control";
}

function isCause(value: unknown): value is DeployCause {
  return typeof value === "string" && (DEPLOY_CAUSES as readonly string[]).includes(value);
}

function readJevCause(response: unknown): DeployCause | null {
  if (!response || typeof response !== "object") return null;
  const choice = (response as { answers?: { cause?: { choice?: unknown } } }).answers?.cause?.choice;
  return isCause(choice) ? choice : null;
}

function readJsonCause(response: unknown): { cause: DeployCause; note?: string } | null {
  const content = contentOf(response);
  if (!content) return null;
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(content.slice(start, end + 1)) as { cause?: unknown; explanationFa?: unknown };
    if (!isCause(parsed.cause)) return null;
    const note = typeof parsed.explanationFa === "string" ? parsed.explanationFa.trim() : "";
    return { cause: parsed.cause, note: safeNote(note) };
  } catch {
    return null;
  }
}

function contentOf(response: unknown): string {
  if (!response || typeof response !== "object") return "";
  const content = (response as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
  return contentText(content);
}

function safeNote(note: string): string | undefined {
  if (note.length < 12 || note.length > 400) return undefined;
  if (/POST|execute_action|curl|Bearer|eyJ/i.test(note)) return undefined;
  return redactSecrets(note);
}

function evidenceSummary(evidence: DeployEvidence): string {
  return summarizeForModel({
    stage: evidence.stage,
    error: evidence.error,
    probes: (evidence.probes ?? []).map((probe) => ({ name: probe.name, status: probe.status, error: probe.error })),
    releaseId: evidence.releaseId,
    releaseStatus: evidence.releaseStatus,
    buildLogTail: (evidence.buildLogTail ?? []).slice(-8),
    hasPendingCard: Boolean(evidence.pendingCard),
  });
}

async function askModels(
  evidence: DeployEvidence,
  deps: ExplainDeps,
): Promise<{ cause: DeployCause; layer: Exclude<DeployLayer, "rules">; note?: string } | null> {
  if (deps.useModel === false) return null;
  const timeoutMs = deps.timeoutMs ?? config.llmTimeoutHintMs;
  const decisionModel = config.llmDecisionModel;
  const primary = config.llmModel;
  const fallback = config.llmModelFallback;
  const summary = evidenceSummary(evidence);
  if (!(decisionModel || deps.callJev || primary || deps.callModel)) return null;

  if (decisionModel || deps.callJev) {
    try {
      const response = await (deps.callJev ?? callJevEndpoint)({
        model: decisionModel || "typesafe/jev-1.14",
        state: { text: summary },
        questions: {
          cause: {
            type: "choice",
            instructions: "یک علت را فقط از روی شواهد انتخاب کن. نوشتن، اجرای دوباره، یا دیدن توکن را پیشنهاد نکن.",
            criteria: CAUSE_FA,
          },
        },
      }, timeoutMs);
      const cause = readJevCause(response);
      if (cause) return { cause, layer: "jev" };
    } catch {
      /* نوبت مدل بعدی */
    }
  }

  const ask = async (model: string, repair: boolean) => {
    const call = deps.callModel ?? callChatEndpoint;
    const instruction = `فقط JSON برگردان. cause یکی از ${DEPLOY_CAUSES.join("، ")} است. explanationFa یک جملهٔ فارسی است و دستور نوشتن ندارد.`;
    const first = readJsonCause(await call(model, [
      { role: "system", content: instruction },
      { role: "user", content: summary },
    ], timeoutMs));
    if (first || !repair) return first;
    return readJsonCause(await call(model, [
      { role: "system", content: instruction },
      { role: "user", content: `${summary}\nJSON قبلی نامعتبر بود. فقط یک JSON اصلاح‌شده برگردان.` },
    ], timeoutMs));
  };

  if (primary || deps.callModel) {
    try {
      const parsed = await ask(primary || "deepseek", true);
      if (parsed) return { cause: parsed.cause, layer: "deepseek", note: parsed.note };
    } catch {
      /* مدل جایگزین */
    }
  }
  if (fallback && fallback !== primary) {
    try {
      const parsed = await ask(fallback, false);
      if (parsed) return { cause: parsed.cause, layer: "fallback", note: parsed.note };
    } catch {
      /* قواعد */
    }
  }
  return null;
}

export async function explainDeployFailure(
  evidence: DeployEvidence,
  deps: ExplainDeps = {},
): Promise<DeployExplanation> {
  const fallback = classifyDeployFailure(evidence);
  const model = await askModels(evidence, deps);
  const cause = model?.cause ?? fallback;
  const layer = model?.layer ?? "rules";
  const next: DeployNext = evidence.pendingCard ? "approval_card" : "explain_only";
  const lines = [
    `علت: ${CAUSE_FA[cause]}`,
    layer === "rules"
      ? "مدل در این قدم علتی از فهرست مجاز نداد؛ این جمله از قواعد همین شواهد است."
      : `این علت را لایهٔ ${layer} از روی شواهد خواندنی انتخاب کرد.`,
  ];
  if (evidence.error && !evidence.probes?.length) lines.push(`خطای دیده‌شده: ${redactSecrets(evidence.error).slice(0, 500)}`);
  if (evidence.probes?.length) {
    lines.push("بررسی‌های ردشده:");
    for (const probe of evidence.probes) {
      lines.push(`• ${probe.name} — وضعیت ${probe.status ?? "بدون پاسخ"}${probe.error ? ` — ${redactSecrets(probe.error)}` : ""}`);
    }
  }
  if (evidence.releaseId) lines.push(`انتشار: ${evidence.releaseId} — وضعیت ${evidence.releaseStatus ?? "نامعلوم"}`);
  if (evidence.buildLogTail?.length) {
    lines.push("آخر لاگ بیلد:");
    for (const line of evidence.buildLogTail.slice(-8)) lines.push(`• ${redactSecrets(line).slice(0, 200)}`);
  }
  if (model?.note) lines.push(model.note);
  if (next === "approval_card" && evidence.pendingCard) {
    lines.push("قدم بعدی: کارت تأیید زیر. بدون تأیید شما هیچ نوشتنی انجام نمی‌شود.");
    lines.push(evidence.pendingCard);
  } else {
    lines.push("قدم بعدی: کارت تأییدی ساخته نشد. این مورد با یک نوشتن روی لیارا از اینجا درست نمی‌شود.");
  }
  return { text: lines.join("\n"), cause, layer, next };
}
