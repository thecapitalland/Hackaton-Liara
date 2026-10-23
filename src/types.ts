/**
 * Agate-Liara — انواع مشترک داده در کل سرور.
 */
import type { Risk } from "./approval.js";

/* ── شواهد ─────────────────────────────────────────────────────────── */
export type EvidenceSource = "logs" | "metrics" | "events" | "probe" | "env";

export interface Evidence {
  id: string;
  source: EvidenceSource;
  observation: string;
  available: boolean;
  collectedAt: string;
}

export type RemedyKind =
  | "restart"
  | "resize"
  | "code_fix"
  | "set_env"
  | "scale"
  | "rollback_last_env_change";

export interface Hypothesis {
  /** شناسهٔ علت (مثلاً memory_leak) */
  id: string;
  rank: number;
  cause: string;
  confidence: number;
  evidenceIds: string[];
  kind: "observed" | "inferred";
  remedies: RemedyKind[];
  /** توضیح فارسی هر راهکار */
  remedyText: string[];
}

export type IncidentStatus =
  | "investigating"
  | "diagnosed"
  | "awaiting_approval"
  | "remediating"
  | "verified"
  | "failed"
  | "inconclusive";

export interface IncidentReport {
  incidentId: string;
  provider: "liara";
  appId: string;
  observedAt: string;
  status: IncidentStatus;
  evidence: Evidence[];
  hypotheses: Hypothesis[];
  /** اقدام کم‌خطر انتخاب‌شده برای رفع خودکار (توسط LLM یا قواعد) */
  selectedRemedy?: RemedyKind;
  remedySource?: "llm" | "rules";
  verification?: Record<string, unknown> | null;
  limitations: string[];
  /** مسیر fixed یا قدم‌های حلقهٔ agentic. */
  investigation?: InvestigationTrace;
}

export interface InvestigationStep {
  tool: string;
  reason: string;
  summary: string;
  modelMs?: number;
  toolMs?: number;
}

export interface InvestigationTrace {
  mode: "agentic" | "fixed";
  fallbackReason?: string;
  steps: InvestigationStep[];
  toolCalls?: number;
  elapsedMs?: number;
  modelMs?: number;
  toolMs?: number;
  model?: string;
  decisionLayer?: "jev" | "deepseek" | "fallback" | "rules" | "loop";
  decisionModel?: string;
  probabilities?: Record<string, number>;
  cost?: number;
}

/* ── داده‌های خام جمع‌آوری‌شده ─────────────────────────────────────── */

export interface LogLine {
  ts: string | null;
  level: string;
  message: string;
  raw?: unknown;
  /** متن لاگ شبیه دستور تزریق پرامپت بوده و فقط داده است. */
  injectionSuspected?: boolean;
}

export interface EventItem {
  ts: string | null;
  type: string;
  message: string;
  raw?: unknown;
}

export interface Series {
  name: string;
  unit: string;
  points: { ts: string | null; value: number }[];
}

export interface ProbeSample {
  status: number | null;
  latencyMs: number | null;
  error?: string;
}

export interface ProbeResult {
  url: string;
  samples: ProbeSample[];
  ok: boolean;
  p50: number | null;
  errorText?: string;
}

export interface EnvSnapshot {
  /** کلیدهای تعریف‌شده در پروژه */
  defined: string[];
  /** کلیدهای لازم (از تحلیل کد) */
  required: string[];
}

export interface PlanLimits {
  bundlePlanID?: string;
  monthlyPrice?: number;
  planID?: string;
  name?: string;
  ramMB?: number;
  cpuCores?: number;
  price?: string;
  region?: string;
}

/* ── قرارداد تأیید (برای structuredContent) ────────────────────────── */
export interface ApprovalRequestPayload {
  approvalId: string;
  tool: string;
  app?: string;
  params: Record<string, unknown>;
  summaryFa: string;
  risk: Risk;
  impact: string;
  hash: string;
  expiresAt: string;
  status: "pending" | "approved" | "rejected" | "expired" | "used";
}
