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

export type RemedyKind = "restart" | "resize" | "code_fix" | "set_env" | "scale";

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
  verification?: Record<string, unknown> | null;
  limitations: string[];
}

/* ── داده‌های خام جمع‌آوری‌شده ─────────────────────────────────────── */

export interface LogLine {
  ts: string | null;
  level: string;
  message: string;
  raw?: unknown;
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
