/**
 * Agate-Liara — ابزارهای ترکیبی (سناریوهای کامل).
 *
 * deploy_project · diagnose · apply_fix · verify_fix · connect_domain
 * watch_after_deploy · guide_domain_registration · guide_rollback · guide_github_deploy
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config, isAllowedApp } from "../config.js";
import { fa } from "../i18n/fa.js";
import { liaraGet, liaraPost, uploadSource, LiaraError } from "../liara/client.js";
import { EP } from "../liara/endpoints.js";
import { logsV2Query, metricsSince } from "../liara/queries.js";
import { readPreflightGate } from "../liara/preflight-gate.js";
import { runReadOnlyPreflight, type PreflightReport } from "../liara/preflight-run.js";
import { explainDeployFailure, type DeployEvidence } from "../diagnose/deploy-failure.js";
import { unwrapRelease } from "../liara/release.js";
import { investigateAgentic, summarizeForModel, type AgenticInvestigation, type AgenticToolResult } from "../diagnose/agentic.js";
import { decideIncident } from "../diagnose/decision.js";
import { detectCauses, parseEvents, parseLogs, parseSeries } from "../diagnose/detectors.js";
import {
  rankWithLlm,
  RESTART_REMEDY,
  ROLLBACK_ENV_REMEDY,
  MANUAL_ENV_REMEDY,
  type LlmRankResult,
  type RemedyOption,
} from "../diagnose/llm.js";
import {
  DEFAULT_EVIDENCE_WINDOW_MINUTES,
  filterEventsToWindow,
  filterLogsToWindow,
} from "../diagnose/window.js";
import {
  ENV_CHANGE_WINDOW_SEC,
  captureHealthyEnvBaseline,
  findBaselineRollbackInfo,
  findLatestEnvChange,
  hasEnvBaseline,
  type EnvChangeCandidate,
} from "../env-history.js";
import { detectStack, readProbePaths, type StackDetection } from "../deploy/detect.js";
import {
  cardShowsDiskPlan,
  createsAreAuthorized,
  diskCreateBody,
  formatDiskCard,
  missingDiskSizeCard,
  mountsAreAuthorized,
  fetchProjectDisks,
  parseRemoteDisks,
  planDiskMounts,
  releaseDiskField,
  type DiskCreateSpec,
  type DiskLine,
  type ReleaseDisk,
} from "../deploy/disks.js";
import { assertDiskQuoteUnchanged, quoteDisk, type DiskQuote } from "../liara/plans.js";
import { resolveProjectPath, sanitizeProbePaths } from "../deploy/project-path.js";
import { humanSize, packageSource } from "../deploy/package.js";
import { httpProbe, probeSummary, sleep } from "../probe.js";
import { replacementForCreateResult } from "../liara/plan-followup.js";
import { bullets, faTime, result } from "./common.js";
import { resolveDeployNetwork } from "../liara/networks.js";
import {
  buildEnvRecoveryCardFromApi,
  extractDnsRecords,
  getAction,
  runGuardedAction,
} from "./write.js";
import { parsePlans } from "./read.js";
import { fetchPlanCatalog } from '../liara/plans.js';
import {
  diskFloorGB,
  presentPlanChoice,
  type PlanNeed,
  type PlanPresentation,
} from '../liara/plan-choice.js';
import { readSimilarUsage } from '../liara/similar-usage.js';
import type {
  EventItem,
  Evidence,
  Hypothesis,
  IncidentReport,
  InvestigationTrace,
  LogLine,
  PlanLimits,
  ProbeResult,
  RemedyKind,
  Series,
} from "../types.js";
import { randomUUID } from "node:crypto";

const COMPOSITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/* ─────────────────────────── وضعیت انتشار ─────────────────────────── */

const SUCCESS_STATES = ["ready", "deployed", "success", "succeeded", "active", "finished", "completed"];
const FAILURE_STATES = ["failed", "fail", "error", "canceled", "cancelled", "aborted"];

export function releaseState(raw: unknown): { status: string; ok?: boolean; failed?: boolean } {
  const obj = unwrapRelease(raw);
  const status = String(
    obj["status"] ?? obj["state"] ?? obj["phase"] ?? obj["deploymentStatus"] ?? "",
  ).toLowerCase();
  return {
    status: status || "unknown",
    ok: SUCCESS_STATES.some((s) => status.includes(s)),
    failed: FAILURE_STATES.some((s) => status.includes(s)),
  };
}

/** انتظار برای پایان بیلد با نمایش لاگ بیلد */
async function waitForRelease(
  releaseID: string,
  onProgress?: (line: string) => void,
  timeoutMs = 10 * 60_000,
): Promise<{ ok: boolean; status: string; tail: string[] }> {
  const deadline = Date.now() + timeoutMs;
  const tail: string[] = [];
  let lastSince = Date.now() - 60_000;

  while (Date.now() < deadline) {
    const { data } = await liaraGet<unknown>(EP.getRelease(releaseID));
    const state = releaseState(data);
    if (state.ok) return { ok: true, status: state.status, tail };
    if (state.failed) return { ok: false, status: state.status, tail };

    try {
      const logs = await liaraGet<unknown>(EP.buildLogs(releaseID), {
        query: { since: lastSince },
      });
      const lines = parseLogs(logs.data).map((l) => l.message);
      for (const line of lines.slice(-5)) {
        tail.push(line);
        onProgress?.(line);
      }
      lastSince = Date.now();
    } catch {
      /* لاگ بیلد ممکن است موقتاً در دسترس نباشد */
    }
    await sleep(3000);
  }
  return { ok: false, status: "timeout", tail };
}

/* ─────────────────────────── استقرار ─────────────────────────── */

export interface DeployOutcome {
  text: string;
  structured?: Record<string, unknown>;
}

/** مقادیر مجاز build.location طبق اعتبارسنجی زندهٔ POST /v2/projects/{app}/releases */
export const BUILD_LOCATIONS = ["iran", "germany"] as const;

/**
 * ساخت بدنهٔ release. `build.location` منطقهٔ بیلد است، نه مسیر سورس؛
 * مقدار «.» باعث خطای 400 می‌شود. پیش‌فرض iran و قابل تغییر با LIARA_BUILD_LOCATION.
 */
export function buildReleaseBody(
  detection: StackDetection,
  sourceID: string,
  location: string = process.env.LIARA_BUILD_LOCATION ?? "iran",
): Record<string, unknown> {
  if (!(BUILD_LOCATIONS as readonly string[]).includes(location)) {
    throw new Error(
      `منطقهٔ بیلد «${location}» معتبر نیست؛ فقط ${BUILD_LOCATIONS.join(" یا ")} مجاز است.`,
    );
  }
  const disks = releaseDiskField(detection.disks ?? []);
  return {
    sourceID,
    port: detection.port ?? 3000,
    type: detection.platform,
    message: `Agate-Liara — ${new Date().toISOString()}`,
    // @liara/cli@9.6.0 package/lib/commands/deploy.js:264 و :553-558 — disks: [{name, mountTo}]
    ...(disks.length ? { disks } : {}),
    build: {
      cache: true,
      args: {},
      location,
      ...(detection.platform === "docker" ? { dockerfile: detection.dockerfile || "Dockerfile" } : {}),
    },
  };
}

export interface DeployDiskAuthorization {
  releaseDisks?: ReleaseDisk[];
  diskCreates?: (DiskCreateSpec & { quote?: DiskQuote })[];
  diskLines?: DiskLine[];
}

async function prepareAuthorizedDisks(
  app: string,
  local: NonNullable<StackDetection["disks"]>,
  authorized: DeployDiskAuthorization | undefined,
): Promise<{ stopped?: DeployOutcome; note?: string }> {
  if (!local.length) return {};
  const listed = await fetchProjectDisks(app);
  const remote = parseRemoteDisks(listed.data);
  if (!remote) {
    return {
      stopped: {
        text: "پاسخ فهرست دیسک فیلد disks را که CLI می‌خواند نداشت. هیچ دیسکی ساخته نشد و release ارسال نشد.",
        structured: { ok: false, code: "DISK_LIST_UNRECOGNIZED" },
      },
    };
  }
  const plan = planDiskMounts(local, remote);
  if (plan.blocked.length) {
    const card = missingDiskSizeCard(plan.blocked);
    return { stopped: { text: card.text, structured: card.structured } };
  }
  if (!mountsAreAuthorized(plan.releaseDisks, authorized?.releaseDisks)) {
    return {
      stopped: {
        text: "کارت تأیید همین نام و mountTo را ندارد. release با دیسک ارسال نشد.",
        structured: { ok: false, code: "DISK_MOUNT_UNAPPROVED" },
      },
    };
  }
  if (!createsAreAuthorized(plan.creates, authorized?.diskCreates)) {
    return {
      stopped: {
        text: "ساخت دیسک روی کارت تأیید با همین اندازه و mount نیست. هیچ POSTی ارسال نشد.",
        structured: { ok: false, code: "DISK_CREATE_UNAPPROVED" },
      },
    };
  }
  if (!cardShowsDiskPlan(authorized?.diskLines, plan.releaseDisks, plan.creates)) {
    return {
      stopped: {
        text: "کارت تأیید اندازه و mountTo همین دیسک‌ها را نشان نمی‌دهد. هیچ POSTی ارسال نشد.",
        structured: { ok: false, code: "DISK_CARD_MISMATCH" },
      },
    };
  }
  const notes = [formatDiskCard(plan)];
  for (const create of plan.creates) {
    const approved = authorized?.diskCreates?.find((item) => item.name === create.name);
    try {
      assertDiskQuoteUnchanged(approved?.quote, await quoteDisk({ name: create.name, size: create.size }));
    } catch (err) {
      return {
        stopped: {
          text: (err as Error).message,
          structured: { ok: false, code: "DISK_QUOTE_CHANGED" },
        },
      };
    }
    await liaraPost(EP.createDisk(app), diskCreateBody(create));
    notes.push(`دیسک «${create.name}» ساخته شد. mount در release: ${create.mountTo}`);
  }
  return { note: notes.filter(Boolean).join("\n") };
}

/**
 * بسته‌بندی ← آپلود ← انتشار ← انتظار ← پروب.
 * توسط liara_deploy و deploy_project استفاده می‌شود.
 */
export async function deploySourceToApp(
  app: string,
  srcPath: string,
  authorized?: DeployDiskAuthorization,
): Promise<DeployOutcome> {
  const lines: string[] = [];
  const folder = resolveProjectPath(srcPath);

  lines.push(`${fa.deployDetect}`);
  const detection = detectStack(folder, app);
  lines.push(
    `• پلتفرم: ${detection.platform} | پورت: ${detection.port ?? 3000}${detection.startCommand ? ` | اجرا: ${detection.startCommand}` : ""}`,
  );
  if (detection.requiredEnv.length) {
    lines.push(`• متغیرهای محیطی موردنیاز: ${detection.requiredEnv.join("، ")}`);
  }
  const prepared = await prepareAuthorizedDisks(app, detection.disks ?? [], authorized);
  if (prepared.stopped) return prepared.stopped;
  if (prepared.note) lines.push(prepared.note);

  lines.push(fa.deployPackage);
  const packed = await packageSource(folder);
  lines.push(
    `• ${packed.fileCount} فایل — ${humanSize(packed.bytes)} (${packed.excluded.length} مورد مستثنا شد)`,
  );
  if (packed.bytes > config.maxArchiveBytes) {
    throw new Error(
      `حجم آرشیو (${humanSize(packed.bytes)}) از سقف ${humanSize(config.maxArchiveBytes)} بیشتر است.`,
    );
  }

  const archive = readFileSync(packed.archivePath);
  const { sourceID } = await uploadSource(app, archive);
  lines.push(`${fa.deployUpload} (${humanSize(packed.bytes)}) — source: ${sourceID}`);

  lines.push(fa.deployRelease);
  const releaseBody = buildReleaseBody(detection, sourceID);
  const { data: releaseData } = await liaraPost<Record<string, unknown>>(
    EP.createRelease(app),
    releaseBody,
  );
  const releaseID = String(
    (releaseData ?? {})["releaseID"] ?? (releaseData ?? {})["id"] ?? (releaseData ?? {})["_id"] ?? "",
  );
  if (!releaseID) {
    throw new Error(
      `پاسخ ایجاد انتشار شناسهٔ releaseID نداشت: ${JSON.stringify(releaseData).slice(0, 300)}`,
    );
  }
  lines.push(`⏳ بیلد شروع شد — release: ${releaseID}`);

  const wait = await waitForRelease(releaseID, (l) => lines.push(`   ↳ ${l}`));
  if (!wait.ok) {
    lines.push(`${fa.deployFailed} — وضعیت: ${wait.status}`);
    return {
      text: lines.join("\n"),
      structured: { ok: false, app, releaseID, status: wait.status, stage: "build" },
    };
  }
  lines.push(`${fa.deployDone} — release: ${releaseID}`);

  // پروب سلامت با تا ۶۰ ثانیه تلاش مجدد
  const healthUrl = `https://${app}.liara.run`;
  let probeOk = false;
  let probeText = "";
  const probeDeadline = Date.now() + 60_000;
  while (Date.now() < probeDeadline) {
    const probe = await httpProbe(app, { path: "/health", count: 1 });
    if (!("error" in probe)) {
      probeText = probeSummary(probe);
      if (probe.ok) {
        probeOk = true;
        lines.push(`✅ سلامت: 200 در ${probe.p50 ?? "—"}ms`);
        break;
      }
    }
    await sleep(3000);
  }
  if (!probeOk) {
    lines.push(`⚠️ پروب سلامت موفق نشد:\n${probeText || "(بدون پاسخ)"}`);
  }

  lines.push(`${fa.deployLive}: ${healthUrl}`);
  lines.push(fa.deployRollbackHint);

  return {
    text: lines.join("\n"),
    structured: {
      ok: probeOk,
      app,
      releaseID,
      url: healthUrl,
      health: probeOk,
      platform: detection.platform,
      port: detection.port,
      requiredEnv: detection.requiredEnv,
    },
  };
}

/** ساخت اپ در صورت نبود. کارت پلن بدون تأیید اجرا نمی‌شود و خطای پلن POST دوم نمی‌زند. */
export async function ensureApp(
  app: string,
  platform: string,
  desiredPlan?: string,
  bundlePlanID?: string,
  network?: string,
  projectPath?: string,
): Promise<{ app: string; created: boolean; planID?: string; note?: string; code?: string; failure?: boolean }> {
  try {
    await liaraGet(EP.getProject(app));
    return { app, created: false };
  } catch (error) {
    if (!(error instanceof LiaraError) || error.status !== 404) throw error;
  }

  const resolved = await resolveDeployNetwork(network, "agate-liara");
  if (resolved.kind === "unreadable") {
    return {
      app,
      created: false,
      failure: true,
      code: "NETWORK_REQUIRED",
      note: "فهرست شبکه‌ها از v1/networks خوانده نشد. ساخت اپ پست نشد.",
    };
  }
  if (resolved.kind === "missing") {
    return {
      app,
      created: false,
      failure: true,
      code: "NETWORK_REQUIRED",
      note: `شبکهٔ «${resolved.given}» در فهرست v1/networks نیست. ساخت اپ پست نشد.`,
    };
  }
  if (resolved.kind === "empty") {
    if (app.length <= 2) {
      return {
        app,
        created: false,
        failure: true,
        code: "NETWORK_REQUIRED",
        note: "شبکه‌ای در فهرست نیست و نام اپ برای ساخت شبکه کوتاه است. ساخت اپ پست نشد.",
      };
    }
    const spec = getAction("liara_create_network");
    const out = await runGuardedAction("liara_create_network", { app, networkName: app });
    const text = out.res.content[0]?.type === "text" ? out.res.content[0].text : "";
    return {
      app,
      created: false,
      failure: true,
      code: "NETWORK_REQUIRED",
      note: [
        "فهرست شبکهٔ خصوصی خالی است. ساخت اپ پست نشد.",
        "ساخت شبکه با اقدام liara_create_network پیشنهاد شد.",
        `ریسک: high. اثر: ${spec?.impact ?? ""}`,
        text,
      ].join("\n"),
    };
  }
  if (resolved.kind === "choose") {
    const lines = resolved.networks.map((item) => `«${item.name}» با شناسهٔ ${item.id}`);
    return {
      app,
      created: false,
      failure: true,
      code: "NETWORK_REQUIRED",
      note: `چند شبکه هست و شبکهٔ اپ موجود مشخص نشد. ساخت اپ پست نشد.\n${lines.join("\n")}`,
    };
  }

  const catalog = await fetchPlanCatalog();
  if (!catalog.pairs.length) {
    return {
      app,
      created: false,
      failure: true,
      code: "PLAN_SELECTION_REQUIRED",
      note: "⚠️ هیچ پلن مجازی برای ساخت اپ در فیلتر CLI (free یا شامل g2، available، منطقهٔ ایران) با قیمت واقعی پیدا نشد.",
    };
  }

  const detected = projectPath ? detectStack(projectPath, app) : undefined;
  const usage = await readSimilarUsage(platform, app);
  const need: PlanNeed = {
    platform,
    diskGB: diskFloorGB(detected?.disks),
    memoryGB: usage.memoryGB,
    cpuCores: usage.cpuCores,
    similarApp: usage.similarApp,
    usageNote: usage.usageNote,
  };
  const explicit = desiredPlan && bundlePlanID ? { planID: desiredPlan, bundlePlanID } : undefined;
  if ((desiredPlan || bundlePlanID) && !explicit) {
    throw new Error("ترکیب صریح planID و bundlePlanID باید با هم داده شود.");
  }
  const presentation = presentPlanChoice(catalog.pairs, need, explicit);
  if (!presentation) {
    throw new Error("ترکیب صریح planID و bundlePlanID باید زیر کلید دقیق API موجود و فعال باشد.");
  }

  const params = createParams(app, platform, resolved.network.id, projectPath, presentation, need);
  params["networkName"] = resolved.network.name;
  params["networkReasonFa"] = resolved.reasonFa;
  params["networkOthersFa"] = resolved.others.length
    ? `شبکه‌های دیگر: ${resolved.others.map((item) => `«${item.name}» با شناسهٔ ${item.id}`).join("، ")}.`
    : "";
  const out = await runGuardedAction("liara_create_app", params);
  const structured = (out.res.structuredContent ?? {}) as Record<string, unknown>;
  const text = out.res.content[0]?.type === "text" ? out.res.content[0].text : "";
  if (structured["ok"] === true) return { app, created: true, planID: String(structured["planID"] ?? presentation.recommended.planID) };

  const follow = await replacementForCreateResult(params, { structuredContent: structured, text });
  if (follow) {
    const followStructured = (follow.structuredContent ?? {}) as Record<string, unknown>;
    const followText = follow.content[0]?.type === "text" ? follow.content[0].text : "";
    return {
      app,
      created: false,
      failure: true,
      code: String(followStructured["code"] ?? "PLAN_REJECTED"),
      note: followText,
    };
  }

  return {
    app,
    created: false,
    planID: presentation.recommended.planID,
    failure: structured["code"] !== "APPROVAL_REQUIRED",
    code: structured["code"] === "APPROVAL_REQUIRED" ? "APPROVAL_REQUIRED" : "PLAN_SELECTION_REQUIRED",
    note: text,
  };
}

function createParams(
  app: string,
  platform: string,
  network: string | undefined,
  projectPath: string | undefined,
  presentation: PlanPresentation,
  need: PlanNeed,
): Record<string, unknown> {
  return {
    name: app,
    planID: presentation.recommended.planID,
    platform,
    bundlePlanID: presentation.recommended.bundlePlanID,
    ...(network ? { network } : {}),
    ...(projectPath ? { projectPath } : {}),
    planReasonFa: presentation.reasonFa,
    planCheaperFa: presentation.cheaperFa,
    planStrongerFa: presentation.strongerFa,
    planChoices: presentation.choices,
    planNeed: need,
  };
}

/* ─────────────────────────── تشخیص ─────────────────────────── */

interface Baseline {
  incidentId: string;
  app: string;
  observedAt: string;
  /** زمان شروع رخداد؛ برای rollback دقیق‌تر از observedAt. */
  incidentAt?: string;
  planID?: string;
  probe: { url: string; p50: number | null; statuses: (number | null)[]; ok: boolean };
  cpu: { min: number; max: number; avg: number; last: number } | null;
  memory: { min: number; max: number; avg: number; last: number } | null;
  errorPattern?: string;
  errorsSeen: number;
}

function baselinePath(app: string, stateDir = config.stateDir): string {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(app)) throw new Error('نام اپ نامعتبر است.');
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  return path.join(stateDir, `baseline-${app}.json`);
}

function saveBaseline(app: string, baseline: Baseline, stateDir = config.stateDir): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(baselinePath(app, stateDir), JSON.stringify(baseline, null, 2), "utf8");
}

function loadBaseline(app: string): Baseline | null {
  try {
    if (!existsSync(baselinePath(app))) return null;
    return JSON.parse(readFileSync(baselinePath(app), "utf8")) as Baseline;
  } catch {
    return null;
  }
}

const ERROR_PATTERNS = [
  /TypeError:\s*Cannot read properties of undefined \(reading '([^']+)'\)/i,
  /ReferenceError:\s*(\w+) is not defined/i,
  /(\w+) is not a function/i,
  /Cannot read properties of undefined/i,
  /JavaScript heap out of memory/i,
  /\bECONNRESET\b/i,
  /\bETIMEDOUT\b/i,
];

/** استخراج الگوی خطای غالب از لاگ‌ها */
export function dominantErrorPattern(logs: LogLine[]): { pattern: string; count: number } | null {
  let best: { pattern: string; count: number } | null = null;
  for (const re of ERROR_PATTERNS) {
    const hits = logs.filter((l) => re.test(l.message));
    if (hits.length && (!best || hits.length > best.count)) {
      best = { pattern: re.source, count: hits.length };
    }
  }
  if (best) return best;
  const errorLogs = logs.filter((l) => l.level === "error");
  if (errorLogs.length) {
    return { pattern: errorLogs[errorLogs.length - 1]!.message.slice(0, 160), count: errorLogs.length };
  }
  return null;
}

interface DiagnosisBundle {
  incidentId: string;
  app: string;
  observedAt: string;
  /** لنگر پنجرهٔ شواهد: incidentAt معتبر یا observedAt. */
  windowAnchor: string;
  logs: LogLine[];
  events: EventItem[];
  cpu: Series | null;
  memory: Series | null;
  probe: ProbeResult | { error: string };
  env: { defined: string[]; required: string[] } | null;
  plan: PlanLimits | null;
  evidence: Evidence[];
  hypotheses: Hypothesis[];
  notes: string[];
  llmUsed: boolean;
  llmNote?: string;
  selectedRemedy: RemedyKind;
  remedySource: "llm" | "rules";
  rollbackAvailable: boolean;
  envChangeAt?: string;
  envChangeSource?: string;
}

export interface DiagnosisOptions {
  /** زمان شروع رخداد؛ لنگر پنجرهٔ شواهد و جست‌وجوی تغییر env. پیش‌فرض زمان مشاهده. */
  incidentAt?: string;
  /** پروب همان چرخهٔ پایش؛ در نبود آن، diagnose خودش پروب می‌کند. */
  probe?: ProbeResult;
  /** رویدادهای همان چرخه؛ در نبود آن، diagnose خودش می‌خواند. */
  events?: EventItem[];
  logs?: LogLine[];
  cpu?: Series | null;
  memory?: Series | null;
  plan?: PlanLimits | null;
  /** بازهٔ شواهد؛ پیش‌فرض ۱۰ دقیقه. */
  eventWindowMinutes?: number;
  /** بازهٔ جست‌وجوی تغییر env؛ پیش‌فرض ۱۰ دقیقه. */
  envChangeWindowSec?: number;
  /** برای تست deterministic یا تزریق نتیجهٔ جست‌وجوی env. */
  envChange?: EnvChangeCandidate | null;
  /** برای تست؛ releaseهای تزریقی به‌جای API لیارا. */
  releases?: unknown;
  /** برای تست؛ اگر باشد audit.jsonl خوانده نمی‌شود. */
  auditEntries?: import("../audit.js").AuditEntry[];
  /** در production پیش‌فرض true است. */
  includeReleaseEnvEvents?: boolean;
  /** برای تست؛ مسیر ذخیرهٔ baseline. */
  stateDir?: string;
  /** مسیرهای پروب علاوه بر پیش‌فرض. */
  probePaths?: string[];
  /** مسیر مطلق پروژه برای خواندن probePaths از liara.json. */
  projectPath?: string;
  /** اگر false، LLM حتی با پیکربندی کامل فراخوانی نمی‌شود (تست/آفلاین). */
  llm?: boolean;
  /** agentic حلقهٔ ابزار می‌زند؛ fixed همان جمع‌آوری و رتبه‌بندی فعلی است. */
  investigateMode?: "agentic" | "fixed";
  /** تزریق LLM و ابزار برای تست. در اجراهای واقعی خالی می‌ماند. */
  agentic?: {
    model?: string;
    now?: () => number;
    limits?: { maxToolCalls?: number; totalMs?: number; llmTimeoutMs?: number; toolTimeoutMs?: number };
    remedies?: RemedyOption[];
    decisionModel?: string;
    fallbackModel?: string;
    callLlm?: (body: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;
    seed?: boolean;
    callJev?: (body: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;
    callModel?: (model: string, messages: { role: string; content: string }[], timeoutMs: number) => Promise<unknown>;
    executeTool?: (name: string, args: Record<string, unknown>) => Promise<AgenticToolResult>;
    detect?: typeof detectCauses;
  };
  /**
   * ثبت snapshot سالم env در diagnose. پیش‌فرض true است، ولی وقتی envChange
   * تزریق شده باشد (مسیر تست/deterministic) خودکار غیرفعال می‌شود.
   */
  captureBaseline?: boolean;
}

async function gatherDiagnosis(
  app: string,
  symptom: string | undefined,
  options: DiagnosisOptions = {},
): Promise<DiagnosisBundle> {
  const notes: string[] = [];
  const observedAt = new Date().toISOString();
  const windowMinutes = options.eventWindowMinutes ?? DEFAULT_EVIDENCE_WINDOW_MINUTES;
  const incidentMs = options.incidentAt ? Date.parse(options.incidentAt) : Number.NaN;
  const windowAnchor = Number.isFinite(incidentMs) ? options.incidentAt! : observedAt;
  const anchorMs = Number.isFinite(incidentMs) ? incidentMs : Date.parse(observedAt);

  /* لاگ‌ها: درخواست از قبل به بازهٔ رخداد محدود می‌شود. */
  let logs: LogLine[] = [];
  if (options.logs !== undefined) {
    logs = options.logs;
  } else {
    try {
      const res = await liaraGet<unknown>(EP.logsV2(app), {
        query: logsV2Query(anchorMs - windowMinutes * 60_000, 300),
      });
      logs = parseLogs(res.data);
    } catch {
      try {
        const res = await liaraGet<unknown>(EP.logsV1(app), {
          query: { since: anchorMs - windowMinutes * 60_000 },
        });
        logs = parseLogs(res.data);
      } catch {
        notes.push("دریافت لاگ‌ها ناموفق بود؛ تحلیل بر پایهٔ شواهد ناقص است.");
      }
    }
  }
  const logWindow = filterLogsToWindow(logs, windowAnchor, windowMinutes);
  logs = logWindow.items;
  if (logWindow.dropped) {
    notes.push(`${logWindow.dropped} خط لاگ قدیمی‌تر از ${windowMinutes} دقیقه کنار گذاشته شد.`);
  }

  /* رویدادها: فقط همان بازهٔ رخداد؛ قدیمی‌ترها discard می‌شوند. */
  let rawEvents: EventItem[] = [];
  if (options.events !== undefined) {
    rawEvents = options.events;
  } else {
    try {
      const res = await liaraGet<unknown>(EP.events(app));
      rawEvents = parseEvents(res.data);
    } catch {
      notes.push("دریافت رویدادها ناموفق بود.");
    }
  }
  const eventWindow = filterEventsToWindow(rawEvents, windowAnchor, windowMinutes);
  const events = eventWindow.items;
  if (eventWindow.dropped) {
    notes.push(
      `${eventWindow.dropped} رویداد قدیمی‌تر از ${windowMinutes} دقیقه یا بدون زمان معتبر کنار گذاشته شد.`,
    );
  }

  /* متریک‌ها: بازهٔ ۳۰ دقیقه برای روند، ولی تحلیل رویداد محدود به پنجره است. */
  let cpu: Series | null = options.cpu !== undefined ? options.cpu : null;
  let memory: Series | null = options.memory !== undefined ? options.memory : null;
  if (options.cpu === undefined || options.memory === undefined) {
    const [cpuRes, memRes] = await Promise.allSettled([
      liaraGet<unknown>(EP.metricsCpu(app), { query: { since: metricsSince(anchorMs) } }),
      liaraGet<unknown>(EP.metricsMemory(app), { query: { since: metricsSince(anchorMs) } }),
    ]);
    if (options.cpu === undefined) {
      if (cpuRes.status === "fulfilled") cpu = parseSeries(cpuRes.value.data, "cpu", "%");
      else notes.push("متریک CPU در دسترس نبود.");
    }
    if (options.memory === undefined) {
      if (memRes.status === "fulfilled") memory = parseSeries(memRes.value.data, "memory", "MB");
      else notes.push("متریک حافظه در دسترس نبود.");
    }
  }

  /* پروب: اگر watch همان چرخه را داده باشد، دوباره پروب نمی‌کنیم. */
  let probe: ProbeResult | { error: string };
  if (options.probe !== undefined) {
    probe = options.probe;
  } else {
    probe = await httpProbe(app, { path: "/", count: 3 });
    if ("error" in probe) notes.push(probe.error);
  }

  /*
   * اگر اپ سالم است، snapshot کامل env فقط به‌صورت محلی (0600/gitignored)
   * ثبت می‌شود. این snapshot هرگز به LLM یا گزارش تشخیص نمی‌رود و فقط در
   * remediation برای diff استفاده می‌شود.
   */
  if (
    options.captureBaseline !== false &&
    options.envChange === undefined &&
    !("error" in probe)
  ) {
    try {
      const baseline = await captureHealthyEnvBaseline(app, probe, {
        ...(options.stateDir ? { stateDir: options.stateDir } : {}),
      });
      if (baseline) notes.push("baseline سالم env برای rollback آینده ثبت شد.");
    } catch {
      notes.push("ثبت baseline سالم env ناموفق بود؛ تشخیص بدون آن ادامه می‌یابد.");
    }
  }

  /*
   * استدلال تشخیص env-blind می‌ماند: نه مقدار BUG_MODE و نه فهرست کلیدها.
   * فقط plan برای آستانهٔ CPU از متادیتای اپ گرفته می‌شود. برای انتخاب
   * rollback فقط «وجود/زمان تغییر» و وجود baseline بررسی می‌شود، نه مقدارها.
   */
  let plan: PlanLimits | null = options.plan !== undefined ? options.plan : null;
  if (options.plan === undefined) {
    try {
      const res = await liaraGet<Record<string, unknown>>(EP.getProject(app));
      const obj = (res.data?.project ?? res.data ?? {}) as Record<string, unknown>;
      const currentPlanID = String(obj["plan"] ?? obj["planID"] ?? "");
      plan = currentPlanID ? planFromProject(obj, currentPlanID) : null;
    } catch {
      notes.push("اطلاعات پلن اپ در دسترس نبود.");
    }
  }

  const incidentAt = options.incidentAt ?? observedAt;
  let envChange: EnvChangeCandidate | null = null;
  if (options.envChange !== undefined) {
    envChange = options.envChange;
  } else {
    try {
      envChange = await findLatestEnvChange(app, incidentAt, {
        windowSec: options.envChangeWindowSec ?? ENV_CHANGE_WINDOW_SEC,
        includeReleases: options.includeReleaseEnvEvents !== false,
        // diagnose هرگز baseline diff را محاسبه نمی‌کند.
        includeBaseline: false,
        ...(options.stateDir ? { stateDir: options.stateDir } : {}),
      });
    } catch {
      notes.push("تاریخچهٔ تغییرات env در دسترس نبود؛ rollback خودکار پیشنهاد نمی‌شود.");
    }
  }
  const journalRollbackAvailable =
    envChange?.revertable === true && envChange.changes.length > 0;

  /*
   * بررسی فقط-متادیتای baseline: وجود فایل و یک ENV_UPDATE بعد از آن.
   * هیچ کلید/مقداری وارد استدلال تشخیص یا LLM نمی‌شود؛ diff واقعی فقط در
   * apply_fix/rollback ساخته می‌شود.
   */
  const baselineExists = hasEnvBaseline(app, options.stateDir);
  let baselineInfo: Awaited<ReturnType<typeof findBaselineRollbackInfo>> = null;
  if (!journalRollbackAvailable && baselineExists) {
    try {
      baselineInfo = await findBaselineRollbackInfo(app, incidentAt, {
        includeReleases: options.includeReleaseEnvEvents !== false,
        ...(options.stateDir ? { stateDir: options.stateDir } : {}),
      });
    } catch {
      notes.push("بررسی baseline سالم env ناموفق بود؛ rollback از baseline قابل پیشنهاد نیست.");
    }
  }
  const rollbackAvailable = journalRollbackAvailable || Boolean(baselineInfo);
  const manualEnvRecovery = !rollbackAvailable && !baselineExists && envChange !== null;

  if (baselineInfo) {
    notes.push(
      `baseline سالم env از ${faTime(baselineInfo.baselineAt)} در دسترس است؛ rollback فقط کلیدهای تغییرکرده را برمی‌گرداند.`,
    );
  } else if (envChange && !journalRollbackAvailable) {
    notes.push(
      manualEnvRecovery
        ? "تغییر env اخیری دیده شد و baseline سالم وجود ندارد؛ به‌جای ری‌استارت، کارت ۳ گزینه‌ای بازیابی دستی env پیشنهاد می‌شود."
        : "تغییر env اخیری دیده شد، اما مقدار قبلی آن در تاریخچهٔ محلی یا baseline ثبت نشده؛ rollback دقیق ممکن نیست.",
    );
  }

  const detectionResult = detectCauses({
    app,
    logs,
    events,
    cpu,
    memory,
    probe: "error" in probe ? null : probe,
    env: null,
    plan,
    collectedAt: windowAnchor,
    windowMinutes,
  });

  /* راهکار rollback فقط وقتی در فهرست LLM می‌آید که واقعاً قابل اجرا باشد. */
  if (rollbackAvailable) {
    const rollbackText = "برگرداندن آخرین تغییر env قبل از رخداد (فقط کلیدهای تغییرکرده).";
    for (const hypothesis of detectionResult.hypotheses) {
      if (!hypothesis.remedies.includes("rollback_last_env_change")) {
        hypothesis.remedies = ["rollback_last_env_change", ...hypothesis.remedies];
        hypothesis.remedyText = [rollbackText, ...hypothesis.remedyText];
      }
    }
  } else if (manualEnvRecovery) {
    const manualText =
      "بازیابی دستی env: انتخاب کلید مشکوک و واردکردن مقدار قبلی با set_env (کارت ۳ گزینه‌ای).";
    for (const hypothesis of detectionResult.hypotheses) {
      if (!hypothesis.remedies.includes("set_env")) {
        hypothesis.remedies = ["set_env", ...hypothesis.remedies];
        hypothesis.remedyText = [manualText, ...hypothesis.remedyText];
      }
    }
  }

  const remedies: RemedyOption[] = [];
  if (rollbackAvailable) remedies.push(ROLLBACK_ENV_REMEDY);
  else if (manualEnvRecovery) remedies.push(MANUAL_ENV_REMEDY);
  else remedies.push(RESTART_REMEDY);

  const llm: LlmRankResult =
    options.llm === false
      ? {
          hypotheses: detectionResult.hypotheses,
          usedLlm: false,
          note: "LLM برای این اجرا غیرفعال شد؛ تحلیل کاملاً بر پایهٔ قواعد.",
        }
      : await rankWithLlm({
          app,
          symptom,
          hypotheses: detectionResult.hypotheses,
          evidence: detectionResult.evidence,
          remedies,
        });
  if (llm.note) notes.push(llm.note);

  let selectedRemedy: RemedyKind =
    llm.selectedRemedy ?? (rollbackAvailable ? "rollback_last_env_change" : manualEnvRecovery ? "set_env" : "restart");
  let remedySource: "llm" | "rules" = llm.selectedRemedy ? "llm" : "rules";
  // قاعدهٔ ایمنی: وقتی baseline نیست و تغییر env دیده شده، LLM هم اجازهٔ
  // پیشنهاد ری‌استارت را ندارد.
  if (manualEnvRecovery && selectedRemedy === "restart") {
    selectedRemedy = "set_env";
    remedySource = "rules";
    notes.push("پیشنهاد ری‌استارت به‌دلیل نبود baseline و وجود تغییر env نادیده گرفته شد؛ بازیابی دستی env انتخاب شد.");
  }

  return {
    incidentId: `inc_${randomUUID().slice(0, 8)}`,
    app,
    observedAt,
    windowAnchor,
    logs,
    events,
    cpu,
    memory,
    probe,
    env: null,
    plan,
    evidence: detectionResult.evidence,
    hypotheses: llm.hypotheses,
    notes,
    llmUsed: llm.usedLlm,
    llmNote: llm.note,
    selectedRemedy,
    remedySource,
    rollbackAvailable,
    ...(baselineInfo
      ? { envChangeAt: baselineInfo.releaseAt, envChangeSource: "baseline" }
      : envChange
        ? { envChangeAt: envChange.at, envChangeSource: envChange.source }
        : {}),
  };
}

function planFromProject(obj: Record<string, unknown>, planID: string): PlanLimits {
  return {
    planID,
    name: typeof obj["planName"] === "string" ? (obj["planName"] as string) : undefined,
    ramMB:
      typeof obj["memory"] === "number"
        ? (obj["memory"] as number)
        : typeof obj["ram"] === "number"
          ? (obj["ram"] as number)
          : undefined,
    cpuCores:
      typeof obj["cpu"] === "number"
        ? (obj["cpu"] as number)
        : typeof obj["cpus"] === "number"
          ? (obj["cpus"] as number)
          : undefined,
  };
}

/** قالب‌بندی گزارش رخداد (۳ سطر رتبه‌بندی + شواهد + گام بعدی) */
export function remedyLabel(kind: RemedyKind): string {
  switch (kind) {
    case "rollback_last_env_change":
      return "برگرداندن کلیدهای تغییرکردهٔ env به مقدار baseline/تاریخچه (ریسک متوسط، با تأیید)";
    case "restart":
      return "ری‌استارت سرویس (کم‌خطر)";
    case "resize":
      return "تغییر پلن";
    case "set_env":
      return "بازیابی دستی env: ورود کلید مشکوک و مقدار قبلی (کارت ۳ گزینه‌ای)";
    case "scale":
      return "روشن/خاموش‌کردن سرویس";
    case "code_fix":
    default:
      return "اصلاح کد";
  }
}

function oneLine(value: string, max = 48): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

/** ابتدای گزارش، تا در ۴۰۰ نویسهٔ اول ممیزی هم ابزار و دلیل و نتیجه باشد. */
function investigationLead(report: IncidentReport): string {
  const trace = report.investigation;
  const mode = !trace || trace.mode === "fixed" ? "fixed" : `agentic${trace.model ? `(${trace.model})` : ""}`;
  const fallback = trace?.fallbackReason ? ` بازگشت:${oneLine(trace.fallbackReason, 80)}` : "";
  const layer = trace?.decisionLayer ? ` لایه:${trace.decisionLayer}` : "";
  const cost = typeof trace?.cost === "number" ? ` هزینه:${trace.cost}` : "";
  const timing = typeof trace?.modelMs === "number" ? ` مدل:${trace.modelMs}ms ابزار:${trace.toolMs ?? 0}ms` : "";
  let text = `مسیر بررسی: ${mode}.${layer}${cost}${timing}${fallback}`.trim();
  const steps = trace?.steps ?? [];
  if (!steps.length) return `${text} قدم:ندارد`;
  for (const step of steps) {
    const piece = ` | ${step.tool}؛ دلیل:${oneLine(step.reason, 24)}؛ نتیجه:${oneLine(step.summary, 28)}؛ مدل:${step.modelMs ?? 0}ms؛ ابزار:${step.toolMs ?? 0}ms`;
    if (text.length + piece.length > 370) {
      text += " | …";
      break;
    }
    text += piece;
  }
  return text;
}

export function formatIncident(report: IncidentReport, extraNotes: string[] = []): string {
  const lines: string[] = [];
  lines.push(`${fa.diagnoseHeader(report.appId)}`);
  lines.push(`🆔 شناسهٔ رخداد: ${report.incidentId} — زمان مشاهده: ${faTime(report.observedAt)}`);
  lines.push("");

  if (!report.hypotheses.length) {
    lines.push(`❓ ${fa.noCause}`);
  } else {
    lines.push("| # | علت محتمل | اطمینان | نوع | شواهد |");
    lines.push("|---|-----------|---------|------|--------|");
    for (const h of report.hypotheses) {
      lines.push(
        `| ${h.rank} | ${h.cause} | ${Math.round(h.confidence * 100)}٪ | ${h.kind === "observed" ? fa.observed : fa.inferred} | ${h.evidenceIds.join("، ")} |`,
      );
    }
    lines.push("");
    for (const h of report.hypotheses) {
      lines.push(`• ${h.rank}) ${h.cause}`);
      for (const t of h.remedyText) lines.push(`   ↳ ${t}`);
    }
  }

  if (report.selectedRemedy) {
    lines.push(
      "",
      `🧭 اقدام پیشنهادی: ${remedyLabel(report.selectedRemedy)}${
        report.remedySource === "llm" ? " (انتخاب LLM)" : " (قواعد)"
      }`,
    );
  }

  lines.push("");
  lines.push("🧾 شواهد:");
  for (const e of report.evidence) {
    lines.push(`• [${e.id}] (${e.source}${e.available ? "" : " — ناموجود"}) ${e.observation}`);
  }

  lines.push("");
  lines.push("🔎 مسیر بررسی:");
  if (!report.investigation || report.investigation.mode === "fixed") {
    lines.push("• حالت: fixed");
  } else {
    lines.push(`• حالت: agentic${report.investigation.model ? ` (${report.investigation.model})` : ""}`);
  }
  if (report.investigation?.fallbackReason) {
    lines.push(`• بازگشت به fixed: ${report.investigation.fallbackReason}`);
  }
  if (report.investigation?.decisionLayer) {
    lines.push(`• لایهٔ تصمیم: ${report.investigation.decisionLayer}${report.investigation.decisionModel ? ` (${report.investigation.decisionModel})` : ""}`);
  }
  if (report.investigation?.probabilities) {
    lines.push(`• احتمال‌ها: ${Object.entries(report.investigation.probabilities).map(([id, value]) => `${id}=${value}`).join("، ")}`);
  }
  if (typeof report.investigation?.cost === "number") {
    lines.push(`• هزینه: ${report.investigation.cost}`);
  }
  if (!report.investigation?.steps.length) {
    lines.push("• قدم ابزاری ثبت نشد.");
  } else {
    for (const step of report.investigation.steps) {
      const timing = step.modelMs !== undefined || step.toolMs !== undefined
        ? ` (مدل ${step.modelMs ?? 0}ms، ابزار ${step.toolMs ?? 0}ms)`
        : "";
      lines.push(`• ${step.tool} — دلیل: ${step.reason}${timing}`);
      lines.push(`   ↳ ${step.summary}`);
    }
  }

  if (report.limitations.length) {
    lines.push("");
    lines.push("⚠️ محدودیت‌ها:");
    for (const l of report.limitations) lines.push(`• ${l}`);
  }
  if (extraNotes.length) {
    for (const n of extraNotes) lines.push(`ℹ️ ${n}`);
  }

  lines.push("");
  lines.push(`➡️ ${fa.nextStep}: برای اعمال راهکار، apply_fix را با incidentId="${report.incidentId}" و یکی از گزینه‌های پیشنهادی صدا بزنید.`);
  return lines.join("\n");
}

/* ─────────────────────────── یافتن محل باگ در کد ─────────────────────────── */

/** جست‌وجوی محل محتمل باگ در سورس پروژه بر اساس امضای خطا */
export function findCodeSuspects(
  root: string,
  errorSignature: string | undefined,
): { file: string; line: number; snippet: string; hint: string }[] {
  const out: { file: string; line: number; snippet: string; hint: string }[] = [];
  if (!errorSignature) return out;

  const propMatch = /reading '([^']+)'/.exec(errorSignature);
  const keywords = propMatch?.[1]
    ? [propMatch[1]]
    : errorSignature
        .replace(/[^\w\s.]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3)
        .slice(0, 3);

  const walk = (dir: string, depth = 0): void => {
    if (depth > 4) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (["node_modules", ".git", ".agate", "dist"].includes(entry)) continue;
      const full = path.join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!/\.(ts|js|mjs|cjs|tsx|jsx)$/i.test(full)) continue;
      let content: string;
      try {
        content = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const linesArr = content.split(/\r?\n/);
      for (let i = 0; i < linesArr.length; i++) {
        const line = linesArr[i]!;
        if (keywords.some((k) => line.includes(k))) {
          out.push({
            file: path.relative(root, full).replace(/\\/g, "/"),
            line: i + 1,
            snippet: line.trim().slice(0, 200),
            hint: `بررسی کنید که مقدار ورودی این خط می‌تواند undefined باشد (کلید مرتبط: ${keywords.join("، ")}).`,
          });
          if (out.length >= 8) return;
        }
      }
    }
  };
  walk(path.resolve(root));
  return out;
}

/* ─────────────────────────── اجرای تشخیص ─────────────────────────── */

export interface DiagnosisRun {
  report: IncidentReport;
  /** گزارش فارسی کامل، شامل سطر منبع تحلیل و محدودیت‌ها */
  text: string;
  analysisLine: string;
  llmUsed: boolean;
  llmNote?: string;
  /** اقدام کم‌خطر پیشنهادی برای remediation */
  selectedRemedy: RemedyKind;
  remedySource: "llm" | "rules";
  rollbackAvailable: boolean;
  envChangeAt?: string;
  envChangeSource?: string;
}

/**
 * یک اجرای کامل diagnose: جمع‌آوری شواهد، رتبه‌بندی، ذخیرهٔ baseline و ساخت گزارش.
 * watch_app هم از همین مسیر استفاده می‌کند تا env و بدنهٔ /health هرگز وارد
 * ورودی تشخیص نشوند.
 */
function agenticRequested(options: DiagnosisOptions): boolean {
  if (options.llm === false) return false;
  return (options.investigateMode ?? config.investigateMode) === "agentic";
}

async function agenticRemedyContext(app: string, options: DiagnosisOptions): Promise<{
  remedies: RemedyOption[];
  rollbackAvailable: boolean;
  manualEnvRecovery: boolean;
  envChangeAt?: string;
  envChangeSource?: string;
}> {
  if (options.agentic?.remedies?.length) {
    const remedies = options.agentic.remedies;
    return {
      remedies,
      rollbackAvailable: remedies.some((item) => item.id === "rollback_last_env_change"),
      manualEnvRecovery: remedies.some((item) => item.id === "set_env"),
    };
  }
  const incidentAt = options.incidentAt ?? new Date().toISOString();
  let envChange: EnvChangeCandidate | null = options.envChange === undefined ? null : options.envChange;
  if (options.envChange === undefined) {
    try {
      envChange = await findLatestEnvChange(app, incidentAt, {
        windowSec: options.envChangeWindowSec ?? ENV_CHANGE_WINDOW_SEC,
        includeReleases: options.includeReleaseEnvEvents !== false,
        includeBaseline: false,
        ...(options.stateDir ? { stateDir: options.stateDir } : {}),
        ...(options.releases !== undefined ? { releases: options.releases } : {}),
        ...(options.auditEntries ? { auditEntries: options.auditEntries } : {}),
      });
    } catch {
      envChange = null;
    }
  }
  const journalRollback = envChange?.revertable === true && envChange.changes.length > 0;
  const baselineExists = hasEnvBaseline(app, options.stateDir);
  let baselineAt: string | undefined;
  let baselineReleaseAt: string | undefined;
  if (!journalRollback && baselineExists) {
    try {
      const info = await findBaselineRollbackInfo(app, incidentAt, {
        includeReleases: options.includeReleaseEnvEvents !== false,
        ...(options.stateDir ? { stateDir: options.stateDir } : {}),
        ...(options.releases !== undefined ? { releases: options.releases } : {}),
      });
      baselineAt = info?.baselineAt;
      baselineReleaseAt = info?.releaseAt;
    } catch {
      baselineAt = undefined;
    }
  }
  const rollbackAvailable = journalRollback || Boolean(baselineAt);
  const manualEnvRecovery = !rollbackAvailable && !baselineExists && envChange !== null;
  const remedies = rollbackAvailable
    ? [ROLLBACK_ENV_REMEDY]
    : manualEnvRecovery
      ? [MANUAL_ENV_REMEDY]
      : [RESTART_REMEDY];
  return {
    remedies,
    rollbackAvailable,
    manualEnvRecovery,
    ...(baselineReleaseAt
      ? { envChangeAt: baselineReleaseAt, envChangeSource: "baseline" }
      : envChange
        ? { envChangeAt: envChange.at, envChangeSource: envChange.source }
        : {}),
  };
}

function bundleFromAgentic(
  app: string,
  attempt: AgenticInvestigation,
  remedy: Awaited<ReturnType<typeof agenticRemedyContext>>,
  options: DiagnosisOptions,
): DiagnosisBundle {
  let selectedRemedy = attempt.selectedRemedy
    ?? (remedy.rollbackAvailable ? "rollback_last_env_change" : remedy.manualEnvRecovery ? "set_env" : "restart");
  let remedySource = attempt.remedySource;
  const notes = [...attempt.notes];
  if (remedy.manualEnvRecovery && selectedRemedy === "restart") {
    selectedRemedy = "set_env";
    remedySource = "rules";
    notes.push("پیشنهاد ری‌استارت به‌دلیل نبود baseline و وجود تغییر env نادیده گرفته شد؛ بازیابی دستی env انتخاب شد.");
  }
  const observedAt = new Date().toISOString();
  return {
    incidentId: `inc_${randomUUID().slice(0, 8)}`,
    app,
    observedAt,
    windowAnchor: options.incidentAt ?? observedAt,
    logs: attempt.logs,
    events: attempt.events,
    cpu: attempt.cpu,
    memory: attempt.memory,
    probe: attempt.probe ?? { error: "در حلقهٔ agentic پروبی ثبت نشد." },
    env: null,
    plan: options.plan ?? null,
    evidence: attempt.evidence,
    hypotheses: attempt.hypotheses,
    notes,
    llmUsed: true,
    llmNote: notes.join(" ") || undefined,
    selectedRemedy,
    remedySource,
    rollbackAvailable: remedy.rollbackAvailable,
    ...(remedy.envChangeAt ? { envChangeAt: remedy.envChangeAt, envChangeSource: remedy.envChangeSource } : {}),
  };
}

function decisionSummary(attempt: AgenticInvestigation, fallback: string): string {
  const probe = attempt.probe;
  const samples = probe?.samples.map((sample) => `${sample.status ?? "?"}/${sample.latencyMs}ms`).join(",") ?? "none";
  const memory = attempt.memory?.points.at(-1)?.value ?? "—";
  const header = `پروب p50=${probe?.p50 ?? "—"} samples=${samples} حافظه=${memory} لاگ=${attempt.logs.length}`;
  const steps = attempt.steps.map((step) => `${step.tool}: ${step.summary}`).join("\n");
  return summarizeForModel(`${header}\n${steps || fallback}`);
}

function withAttemptEvidence(options: DiagnosisOptions, attempt: AgenticInvestigation): DiagnosisOptions {
  return {
    ...options,
    ...(options.logs === undefined && attempt.logs.length ? { logs: attempt.logs } : {}),
    ...(options.events === undefined && attempt.events.length ? { events: attempt.events } : {}),
    ...(options.cpu === undefined && attempt.cpu ? { cpu: attempt.cpu } : {}),
    ...(options.memory === undefined && attempt.memory ? { memory: attempt.memory } : {}),
    ...(options.plan === undefined && attempt.plan ? { plan: attempt.plan } : {}),
    ...(options.probe === undefined && attempt.probe ? { probe: attempt.probe } : {}),
  };
}

export async function runDiagnosis(
  app: string,
  symptom?: string,
  options: DiagnosisOptions = {},
): Promise<DiagnosisRun> {
  let trace: InvestigationTrace = { mode: "fixed", steps: [] };
  let bundle: DiagnosisBundle;
  if (agenticRequested(options)) {
    const canCall = Boolean(options.agentic?.callLlm) || config.llmEnabled;
    if (!canCall) {
      trace = { mode: "fixed", steps: [], fallbackReason: "INVESTIGATE_MODE=agentic اما LLM تنظیم نشده است." };
      bundle = await gatherDiagnosis(app, symptom, options);
      bundle.notes.unshift(trace.fallbackReason!);
    } else {
      const remedy = await agenticRemedyContext(app, options);
      const fromFile = options.projectPath ? readProbePaths(resolveProjectPath(options.projectPath)) : [];
      const attempt = await investigateAgentic({
        app,
        symptom,
        remedies: remedy.remedies,
        probePaths: [...sanitizeProbePaths(options.probePaths), ...fromFile],
        model: options.agentic?.model ?? config.llmModel,
        now: options.agentic?.now,
        limits: options.agentic?.limits,
        callLlm: options.agentic?.callLlm,
        executeTool: options.agentic?.executeTool,
        seed: options.agentic?.seed ?? !options.agentic?.executeTool,
        detect: options.agentic?.detect,
      });
      const decisionModel = options.agentic?.decisionModel ?? config.llmDecisionModel;
      const useDecision = Boolean(options.agentic?.callJev || options.agentic?.decisionModel || (!options.agentic?.callLlm && decisionModel));
      const decisionStarted = Date.now();
      const decision = useDecision
        ? await decideIncident({
            decisionModel,
            primaryModel: options.agentic?.model ?? config.llmModel,
            fallbackModel: options.agentic?.fallbackModel ?? config.llmModelFallback,
            summary: decisionSummary(attempt, symptom || app),
            remedies: remedy.remedies,
            evidenceIds: attempt.evidence.map((item) => item.id),
            logs: attempt.logs,
            events: attempt.events,
            cpu: attempt.cpu,
            memory: attempt.memory,
            plan: attempt.plan ?? options.plan ?? null,
            probe: attempt.probe ?? null,
            detect: options.agentic?.detect,
            callJev: options.agentic?.callJev,
            callModel: options.agentic?.callModel,
            timeoutMs: options.agentic?.limits?.llmTimeoutMs,
            loop: attempt.ok
              ? { ok: true, hypotheses: attempt.hypotheses, selectedRemedy: attempt.selectedRemedy, remedySource: attempt.remedySource }
              : { ok: false, hypotheses: [], remedySource: "rules" },
          })
        : null;
      if (decision?.ok) {
        attempt.ok = true;
        attempt.hypotheses = decision.hypotheses;
        attempt.selectedRemedy = decision.selectedRemedy;
        attempt.remedySource = decision.remedySource;
        attempt.notes.push(`لایهٔ تصمیم: ${decision.layer}${decision.model ? ` (${decision.model})` : ""}`);
      } else if (decision && attempt.hypotheses.some((item) => item.id === "crash_loop")) {
        attempt.ok = false;
        attempt.hypotheses = attempt.hypotheses.filter((item) => item.id !== "crash_loop");
        attempt.reason = decision.reason ?? "crash_loop با شاهد حافظه پذیرفته نشد.";
      }
      trace = {
        mode: attempt.ok ? "agentic" : "fixed",
        steps: attempt.steps,
        toolCalls: attempt.toolCalls,
        elapsedMs: attempt.elapsedMs,
        modelMs: (attempt.modelMs ?? 0) + (useDecision ? Math.max(0, Date.now() - decisionStarted) : 0),
        toolMs: attempt.toolMs,
        model: decision?.model ?? attempt.model,
        decisionLayer: decision?.layer ?? (attempt.ok ? "loop" : "rules"),
        decisionModel: decision?.model,
        probabilities: decision?.probabilities,
        cost: decision?.cost,
        ...(attempt.ok ? {} : { fallbackReason: decision?.reason ?? attempt.reason ?? "بازگشت به مسیر fixed." }),
      };
      if (attempt.ok) {
        bundle = bundleFromAgentic(app, attempt, remedy, options);
      } else {
        bundle = await gatherDiagnosis(app, symptom, withAttemptEvidence(options, attempt));
        bundle.notes.unshift(trace.fallbackReason!);
      }
    }
  } else {
    bundle = await gatherDiagnosis(app, symptom, options);
  }
  const report: IncidentReport = {
    incidentId: bundle.incidentId,
    provider: "liara",
    appId: app,
    observedAt: bundle.observedAt,
    status: bundle.hypotheses.length ? "diagnosed" : "inconclusive",
    evidence: bundle.evidence,
    hypotheses: bundle.hypotheses,
    selectedRemedy: bundle.selectedRemedy,
    remedySource: bundle.remedySource,
    verification: null,
    limitations: [
      "لاگ لیارا استریم نمی‌شود؛ خواندن لاگ بر پایهٔ polling انجام می‌شود.",
      "نتیجهٔ تشخیص بر پایهٔ شواهد موجود در بازهٔ زمانی انتخابی است، نه دادهٔ کامل.",
    ],
    investigation: trace,
  };

  if (trace.mode === "agentic" && options.captureBaseline !== false && options.envChange === undefined) {
    try {
      const saved = await captureHealthyEnvBaseline(app, bundle.probe, {
        ...(options.stateDir ? { stateDir: options.stateDir } : {}),
      });
      if (saved) bundle.notes.push("baseline سالم env برای rollback آینده ثبت شد.");
    } catch {
      bundle.notes.push("ثبت baseline سالم env ناموفق بود؛ تشخیص بدون آن ادامه می‌یابد.");
    }
  }

  // ذخیرهٔ baseline برای verify_fix
  const errPattern = dominantErrorPattern(bundle.logs);
  const probeOk = "error" in bundle.probe ? null : bundle.probe;
  saveBaseline(app, {
    incidentId: bundle.incidentId,
    app,
    observedAt: bundle.observedAt,
    incidentAt: bundle.windowAnchor,
    planID: bundle.plan?.planID,
    probe: {
      url: probeOk?.url ?? "",
      p50: probeOk?.p50 ?? null,
      statuses: probeOk?.samples.map((s) => s.status) ?? [],
      ok: probeOk?.ok ?? false,
    },
    cpu: bundle.cpu ? seriesStats(bundle.cpu) : null,
    memory: bundle.memory ? seriesStats(bundle.memory) : null,
    errorPattern: errPattern?.pattern,
    errorsSeen: errPattern?.count ?? 0,
  }, options.stateDir);

  const analysisLine = trace.fallbackReason
    ? `🧠 منبع تحلیل: بازگشت به مسیر fixed — ${trace.fallbackReason}`
    : trace.decisionLayer && trace.decisionLayer !== "loop" && trace.decisionLayer !== "rules"
      ? `🧠 منبع تحلیل: ${trace.decisionLayer}${trace.decisionModel ? ` (${trace.decisionModel})` : ""} — فرضیه‌ها با detectorهای قانونی سنجیده شدند`
    : trace.mode === "agentic"
      ? `🧠 منبع تحلیل: حلقهٔ agentic${trace.model ? ` (${trace.model})` : ""} — فرضیه‌ها با detectorهای قانونی سنجیده شدند`
      : bundle.llmUsed
        ? `🧠 منبع تحلیل: LLM (${config.llmModel}) — علت‌ها از detectorهای قانونی، رتبه‌بندی و انتخاب راهکار با LLM`
        : `🧠 منبع تحلیل: fallback قانون‌محور${bundle.llmNote ? ` — ${bundle.llmNote}` : ""}`;
  const inputLine =
    `🧾 ورودی تشخیص: لاگ/رویدادهای ${options.eventWindowMinutes ?? DEFAULT_EVIDENCE_WINDOW_MINUTES} دقیقهٔ پیرامون رخداد، متریک، و پروب HTTP؛ ` +
    "مقدار env و بدنهٔ /health استفاده نمی‌شوند (فقط متادیتای وجود تغییر env برای انتخاب اقدام بررسی می‌شود).";
  const text = `${investigationLead(report)}\n${analysisLine}\n${inputLine}\n${formatIncident(report, bundle.notes)}`;
  return {
    report,
    text,
    analysisLine,
    llmUsed: bundle.llmUsed,
    llmNote: bundle.llmNote,
    selectedRemedy: bundle.selectedRemedy,
    remedySource: bundle.remedySource,
    rollbackAvailable: bundle.rollbackAvailable,
    ...(bundle.envChangeAt ? { envChangeAt: bundle.envChangeAt } : {}),
    ...(bundle.envChangeSource ? { envChangeSource: bundle.envChangeSource } : {}),
  };
}

/* ─────────────────────────── ثبت ابزارها ─────────────────────────── */

export interface DeployProjectDeps {
  stateDir?: string;
  runPreflight?: () => Promise<PreflightReport>;
  useModel?: boolean;
}

function textOf(res: { content?: { type?: string; text?: string }[] }): string {
  return res.content?.find((item) => item.type === "text")?.text ?? "";
}

function isApprovalPending(text: string, code: unknown): boolean {
  return code === "APPROVAL_REQUIRED" || text.includes("نیاز به تأیید");
}

/** کارت اول ساخت یا deploy توضیح جدا نمی‌خواهد. شکست شبکه، پلن یا دیسک می‌خواهد. */
export function shouldExplainEnsureStop(stop: { note?: string; code?: string; failure?: boolean }): boolean {
  if (!stop.note) return false;
  if (!stop.failure && isApprovalPending(stop.note, stop.code)) return false;
  return true;
}

function failureStage(code: string | undefined): DeployEvidence["stage"] {
  if (code === "NETWORK_REQUIRED") return "network";
  if (code?.startsWith("DISK_")) return "disk";
  if (code === "PLAN_SELECTION_REQUIRED" || code === "PLAN_REJECTED" || code === "APPROVAL_REQUIRED") return "create_app";
  return "deploy";
}

/** مرحلهٔ خطای نتیجهٔ deploy. کارت اول ساخت اپ این تابع را نمی‌بیند. */
export function deployStopStage(structured: Record<string, unknown>): DeployEvidence["stage"] {
  const code = typeof structured["code"] === "string" ? structured["code"] : "";
  if (code.startsWith("DISK_")) return "disk";
  if (structured["stage"] === "build") return "build";
  if (structured["health"] === false) return "deploy";
  if (typeof structured["releaseID"] === "string") return "release";
  return "deploy";
}

async function explainAndReturn(
  evidence: DeployEvidence,
  deps: DeployProjectDeps,
  code: string,
): Promise<ReturnType<typeof result>> {
  const explained = await explainDeployFailure(evidence, { useModel: deps.useModel !== false });
  return result(explained.text, {
    ok: false,
    code,
    cause: explained.cause,
    layer: explained.layer,
    next: explained.next,
    ...(evidence.probes?.length ? { failedChecks: evidence.probes.map((probe) => probe.name) } : {}),
  });
}

async function readBuildEvidence(releaseId: string): Promise<{ releaseStatus?: string; buildLogTail?: string[] }> {
  let releaseStatus: string | undefined;
  let buildLogTail: string[] | undefined;
  try {
    const release = await liaraGet<unknown>(EP.getRelease(releaseId));
    releaseStatus = releaseState(release.data).status;
  } catch {
    /* خواندن وضعیت release ممکن است جداگانه خطا بدهد */
  }
  try {
    const logs = await liaraGet<unknown>(EP.buildLogs(releaseId), {
      query: { since: Math.floor((Date.now() - 10 * 60_000) / 1000) },
    });
    const tail = parseLogs(logs.data).map((line) => line.message).filter(Boolean).slice(-8);
    if (tail.length) buildLogTail = tail;
  } catch {
    /* لاگ بیلد ممکن است هنوز نرسیده باشد */
  }
  return { releaseStatus, buildLogTail };
}

/**
 * اگر رسید preflight نیست، منقضی است، یا ready نیست، همان بررسی خواندنی اجرا می‌شود.
 * رد شدن آن یا خطای بعدی deploy به لایهٔ تشخیص می‌رود و نوشتنی تازه نمی‌سازد.
 */
export async function runDeployProject(
  input: {
    projectPath?: string;
    path?: string;
    app?: string;
    planID?: string;
    bundlePlanID?: string;
    network?: string;
  },
  deps: DeployProjectDeps = {},
): Promise<ReturnType<typeof result>> {
  try {
    const gate = readPreflightGate(Date.now(), deps.stateDir);
    if (!gate.ok) {
      const report = await (deps.runPreflight ?? (() => runReadOnlyPreflight(deps.stateDir ? { stateDir: deps.stateDir } : {})))();
      if (!report.ready) {
        const probes = report.probes
          .filter((probe) => !probe.ok)
          .map((probe) => ({ name: probe.name, status: probe.status, error: probe.error }));
        return explainAndReturn({
          stage: "preflight",
          error: probes.map((probe) => `${probe.name}: ${probe.status ?? "—"} ${probe.error ?? ""}`).join("\n")
            || `رسید preflight آماده نیست (${gate.reason}).`,
          probes,
        }, deps, "PREFLIGHT_FAILED");
      }
    }

    const folder = resolveProjectPath(input.projectPath || input.path || "");
    const app = input.app || "agate-liara";
    let exists = false;
    try {
      await liaraGet(EP.getProject(app));
      exists = true;
    } catch (error) {
      if (!(error instanceof LiaraError) || error.status !== 404) throw error;
    }
    if (exists && !isAllowedApp(app)) {
      return result(fa.appNotAllowed(app, config.allowedApps), {
        ok: false,
        code: "APP_NOT_ALLOWLISTED",
      });
    }
    const detection = detectStack(folder, app);
    const ensured = await ensureApp(app, detection.platform, input.planID, input.bundlePlanID, input.network, folder);
    if (ensured.note) {
      const code = ensured.code ?? (ensured.note.includes("نیاز به تأیید") ? "APPROVAL_REQUIRED" : "PLAN_SELECTION_REQUIRED");
      if (!shouldExplainEnsureStop({ note: ensured.note, code, failure: ensured.failure })) {
        return result(ensured.note, { ok: false, code });
      }
      return explainAndReturn({
        stage: failureStage(code),
        error: ensured.note,
        pendingCard: ensured.note.includes("شناسهٔ تأیید") ? ensured.note : undefined,
      }, deps, code);
    }
    const outcome = await runGuardedAction("liara_deploy", { app, path: folder });
    const text = textOf(outcome.res);
    const structured = (outcome.res.structuredContent ?? {}) as Record<string, unknown>;
    if (structured["ok"] === true || isApprovalPending(text, structured["code"])) return outcome.res;
    const releaseId = typeof structured["releaseID"] === "string" ? structured["releaseID"] : undefined;
    const stage = deployStopStage(structured);
    const read = stage === "build" && releaseId ? await readBuildEvidence(releaseId) : {};
    return explainAndReturn({
      stage,
      error: text || "انتشار ناموفق بود.",
      releaseId,
      releaseStatus: read.releaseStatus ?? (typeof structured["status"] === "string" ? structured["status"] : undefined),
      buildLogTail: read.buildLogTail,
      pendingCard: text.includes("شناسهٔ تأیید") ? text : undefined,
    }, deps, typeof structured["code"] === "string" ? structured["code"] : "DEPLOY_FAILED");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return explainAndReturn({
      stage: /preflight/i.test(message) ? "preflight" : "deploy",
      error: message,
    }, deps, "DEPLOY_FAILED");
  }
}

export function registerCompositeTools(server: McpServer): void {
  /* ── deploy_project ──────────────────────────────────────────────── */
  server.registerTool(
    "deploy_project",
    {
      title: "استقرار کامل پروژه روی لیارا",
      description:
        "اگر رسید preflight نباشد یا منقضی باشد، اول همان بررسی خواندنی را اجرا می‌کند. سپس تشخیص استک، ساخت اپ با کارت، انتشار و سلامت. خطای ساخت، دیسک، شبکه، release یا بیلد به لایهٔ تشخیص می‌رود. نوشتن بدون کارت انجام نمی‌شود و امتحان دوباره فقط برای خواندن است.",
      inputSchema: {
        projectPath: z.string().optional().describe("مسیر مطلق پوشهٔ پروژه"),
        path: z.string().optional().describe("نام قدیمی projectPath؛ باید مطلق باشد"),
        app: z.string().default("agate-liara").describe("نام اپ در لیارا"),
        planID: z.string().optional().describe('پلن صریحاً انتخاب‌شده توسط کاربر؛ در نبود elicitation'),
        bundlePlanID: z.string().optional().describe('بستهٔ امکانات انتخاب‌شده'),
        network: z.string().optional().describe('شناسهٔ شبکهٔ داخلی انتخاب‌شده در لیارا'),
      },
      annotations: COMPOSITE_ANNOTATIONS,
    },
    async ({ path: src, projectPath, app, planID, bundlePlanID, network }) =>
      runDeployProject({ path: src, projectPath, app, planID, bundlePlanID, network }),
  );

  /* ── diagnose ────────────────────────────────────────────────────── */
  server.registerTool(
    "diagnose",
    {
      title: "تشخیص علت رخداد با شواهد",
      description:
        "اگر INVESTIGATE_MODE=agentic و LLM تنظیم باشد، مدل فقط با ابزارهای read-only بررسی می‌کند و نتیجه با detectorها سنجیده می‌شود. وگرنه همان مسیر fixed است: لاگ، رویداد، متریک و پروب، سپس رتبه‌بندی. env و بدنهٔ /health به مدل نمی‌روند. خروجی شامل بخش مسیر بررسی است.",
      inputSchema: {
        app: z.string().min(1).describe("نام اپ در لیارا"),
        symptom: z.string().optional().describe("علائم گزارش‌شده توسط کاربر (اختیاری)"),
        probePaths: z.array(z.string()).optional().describe("مسیرهای پروب؛ اگر نباشد از liara.json یا پیش‌فرض"),
        projectPath: z.string().optional().describe("مسیر مطلق پروژه برای خواندن probePaths از liara.json"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ app, symptom, probePaths, projectPath }) => {
      try {
        const run = await runDiagnosis(app, symptom, { probePaths, projectPath });
        return result(run.text, {
          ok: true,
          analysisSource: run.llmUsed ? "llm" : "rules",
          llmUsed: run.llmUsed,
          llmNote: run.llmNote,
          llmModel: run.llmUsed ? config.llmModel : undefined,
          selectedRemedy: run.selectedRemedy,
          remedySource: run.remedySource,
          rollbackAvailable: run.rollbackAvailable,
          diagnosisInputExcludes: ["env.values", "BUG_MODE", "health.body"],
          evidenceWindowMinutes: DEFAULT_EVIDENCE_WINDOW_MINUTES,
          ...run.report,
          incident: run.report,
        } as unknown as Record<string, unknown>);
      } catch (err) {
        return result(`❌ تشخیص ناموفق بود: ${(err as Error).message}`, { ok: false });
      }
    },
  );

  /* ── apply_fix ───────────────────────────────────────────────────── */
  server.registerTool(
    "apply_fix",
    {
      title: "اعمال راهکار",
      description:
        "اعمال یکی از راهکارهای علت شناسایی‌شده: restart | rollback_last_env_change | resize | code_fix | set_env. rollback فقط کلیدهای تغییرکرده را به baseline برمی‌گرداند (ریسک medium، نیازمند تأیید). اگر baseline موجود نباشد، به‌جای restart کارت ۳ گزینه‌ای بازیابی دستی env برمی‌گردد؛ code_fix فقط دستورالعمل می‌دهد.",
      inputSchema: {
        app: z.string().min(1).describe("نام اپ در لیارا"),
        incidentId: z.string().min(1).describe("شناسهٔ رخداد از diagnose"),
        option: z
          .enum(["restart", "rollback_last_env_change", "resize", "code_fix", "set_env"])
          .describe("راهکار موردنظر"),
        planID: z.string().optional().describe("پلن جدید برای resize (اختیاری)"),
        variables: z
          .array(z.object({ key: z.string(), value: z.string() }))
          .optional()
          .describe("متغیرهای محیطی برای set_env (اختیاری)"),
        projectPath: z.string().optional().describe("مسیر مطلق پروژه برای code_fix"),
      },
      annotations: COMPOSITE_ANNOTATIONS,
    },
    async ({ app, incidentId, option, planID, variables, projectPath }) => {
      const baseline = loadBaseline(app);
      try {
        if (!baseline || baseline.incidentId !== incidentId) return result('❌ baseline متناظر رخداد پیدا نشد؛ diagnose را اجرا کنید.', { ok: false });
        if (option === "restart") {
          const out = await runGuardedAction("liara_restart", { app });
          return result(
            `${out.res.content?.[0]?.type === "text" ? out.res.content[0].text : ""}\n🆔 رخداد: ${incidentId}`,
            { incidentId, ...(out.res.structuredContent ?? {}) },
          );
        }

        if (option === "rollback_last_env_change") {
          const incidentAt = baseline.incidentAt ?? baseline.observedAt;
          let candidate: EnvChangeCandidate | null = null;
          try {
            // diff واقعی فقط اینجا (remediation) ساخته می‌شود، نه در diagnose.
            candidate = await findLatestEnvChange(app, incidentAt, {
              includeBaseline: true,
            });
          } catch {
            candidate = null;
          }
          if (!candidate || !candidate.revertable || !candidate.changes.length) {
            const reason =
              "برای این رخداد تغییر env قابل‌بازگشتی با مقدار قبلی پیدا نشد؛ rollback دقیق ممکن نیست.";
            const card = await buildEnvRecoveryCardFromApi(app, reason);
            return result(`${card.text}\n🆔 رخداد: ${incidentId}`, {
              incidentId,
              ...card.structured,
            });
          }
          const out = await runGuardedAction("rollback_last_env_change", {
            app,
            incidentAt,
            expectedKeys: candidate.keys,
          });
          return result(
            `${out.res.content?.[0]?.type === "text" ? out.res.content[0].text : ""}\n🆔 رخداد: ${incidentId}`,
            { incidentId, ...(out.res.structuredContent ?? {}) },
          );
        }

        if (option === "resize") {
          let target = planID;
          if (!target) {
            const { data } = await liaraGet<unknown>(EP.me);
            const plans = parsePlans(data);
            const current = baseline?.planID;
            const bigger = plans.find(
              (p) =>
                p.planID !== current &&
                (p.ramMB ?? 0) > (plans.find((x) => x.planID === current)?.ramMB ?? 0),
            );
            target = bigger?.planID ?? plans[plans.length - 1]?.planID ?? "";
          }
          if (!target) {
            return result("❌ پلن مناسبی برای ارتقا پیدا نشد؛ planID را دستی بدهید.", {
              ok: false,
            });
          }
          const out = await runGuardedAction("liara_resize", { app, planID: target });
          return result(
            `${out.res.content?.[0]?.type === "text" ? out.res.content[0].text : ""}\n🆔 رخداد: ${incidentId}`,
            { incidentId, ...(out.res.structuredContent ?? {}) },
          );
        }

        if (option === "set_env") {
          const vars = variables ?? [];
          if (!vars.length) {
            const card = await buildEnvRecoveryCardFromApi(
              app,
              "برای بازیابی دستی env، کلید مشکوک و مقدار قبلی را مشخص کنید؛ baseline سالم برای rollback دقیق وجود ندارد.",
            );
            return result(`${card.text}\n🆔 رخداد: ${incidentId}`, {
              incidentId,
              ...card.structured,
            });
          }
          const out = await runGuardedAction("liara_set_env", { app, variables: vars });
          return result(
            `${out.res.content?.[0]?.type === "text" ? out.res.content[0].text : ""}\n🆔 رخداد: ${incidentId}`,
            { incidentId, ...(out.res.structuredContent ?? {}) },
          );
        }

        /* code_fix — بدون نوشتن روی لیارا */
        let codeRoot = "";
        try {
          codeRoot = resolveProjectPath(projectPath ?? "");
        } catch (err) {
          return result((err as Error).message, { ok: false, code: "PROJECT_PATH_REQUIRED" });
        }
        const suspects = findCodeSuspects(codeRoot, baseline?.errorPattern);
        const guidance = [
          `🛠️ اصلاح کد (راه‌حل دائمی) — رخداد ${incidentId}`,
          baseline?.errorPattern
            ? `الگوی خطای مشاهده‌شده: ${baseline.errorPattern}`
            : "الگوی خطای مشخصی ثبت نشده؛ کلیدهای پرکاربرد را بررسی کنید.",
          suspects.length
            ? "محل‌های محتمل در کد:"
            : "محل مشخصی پیدا نشد؛ محل‌های پرکاربرد را دستی بررسی کنید.",
          ...suspects.map(
            (s) => `• ${s.file}:${s.line} — «${s.snippet}»\n   ↳ ${s.hint}`,
          ),
          "",
          "✅ گام بعدی: فایل بالا را اصلاح کنید، سپس deploy_project را اجرا کنید و بعد verify_fix.",
        ].join("\n");
        return result(guidance, {
          ok: true,
          incidentId,
          option,
          suspects,
          nextAction: "edit code → deploy_project → verify_fix",
        });
      } catch (err) {
        return result(`❌ اعمال راهکار ناموفق بود: ${(err as Error).message}`, { ok: false });
      }
    },
  );

  /* ── verify_fix ──────────────────────────────────────────────────── */
  server.registerTool(
    "verify_fix",
    {
      title: "تأیید رفع مشکل",
      description:
        "پس از راهکار: ۳ پروب + مقایسهٔ متریک با baseline ثبت‌شده + بررسی ناپدیدشدن الگوی خطا. خروجی: تأییدشده یا مشکل باقی است، همراه جدول قبل/بعد.",
      inputSchema: {
        app: z.string().min(1).describe("نام اپ در لیارا"),
        incidentId: z.string().min(1).describe("شناسهٔ رخداد"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ app, incidentId }) => {
      const baseline = loadBaseline(app);
      if (!baseline || baseline.incidentId !== incidentId) return result('❌ baseline متناظر رخداد پیدا نشد؛ diagnose را اجرا کنید.', { ok: false });
      const probe = await httpProbe(app, { path: new URL(baseline.probe.url || `https://${app}.liara.run/`).pathname, count: 3 });
      const [cpuRes, memRes] = await Promise.allSettled([
        liaraGet<unknown>(EP.metricsCpu(app), { query: { since: metricsSince(Date.now(), 15 * 60_000) } }),
        liaraGet<unknown>(EP.metricsMemory(app), { query: { since: metricsSince(Date.now(), 15 * 60_000) } }),
      ]);
      const cpu = cpuRes.status === "fulfilled" ? parseSeries(cpuRes.value.data, "cpu", "%") : null;
      const memory = memRes.status === "fulfilled" ? parseSeries(memRes.value.data, "memory", "MB") : null;

      // بررسی ناپدیدشدن خطا
      let errorsNow: number | null = null;
      let logsNow: LogLine[] = [];
      try {
        const res = await liaraGet<unknown>(EP.logsV2(app), {
          query: logsV2Query(Math.max(Date.parse(baseline.observedAt), Date.now() - 5 * 60_000), 100),
        });
        logsNow = parseLogs(res.data);
        errorsNow = baseline.errorPattern ? logsNow.filter(l => new RegExp(baseline.errorPattern!, 'i').test(l.message)).length : logsNow.filter(l => l.level === 'error').length;
      } catch {
        /* لاگ در دسترس نبود → اثبات نبودِ خطا ممکن نیست */
      }

      const probeOk = "error" in probe ? null : probe;
      const nowStats = {
        cpu: cpu ? seriesStats(cpu) : null,
        memory: memory ? seriesStats(memory) : null,
        p50: probeOk?.p50 ?? null,
        ok: probeOk?.ok ?? false,
        errors: errorsNow,
      };
      const before = baseline;

      const table = [
        "| شاخص | قبل | بعد |",
        "|------|------|------|",
        `| وضعیت پروب | ${before?.probe.ok ? "✅ 200" : "❌ ناموفق"} | ${nowStats.ok ? "✅ 200" : "❌ ناموفق"} |`,
        `| p50 (ms) | ${before?.probe.p50 ?? "—"} | ${nowStats.p50 ?? "—"} |`,
        `| میانگین CPU | ${before?.cpu ? round(before.cpu.avg) : "—"} | ${nowStats.cpu ? round(nowStats.cpu.avg) : "—"} |`,
        `| میانگین حافظه (MB) | ${before?.memory ? round(before.memory.avg) : "—"} | ${nowStats.memory ? round(nowStats.memory.avg) : "—"} |`,
        `| تعداد خطا (۵ دقیقهٔ اخیر) | ${before?.errorsSeen ?? "—"} | ${nowStats.errors} |`,
      ].join("\n");

      const improved =
        nowStats.ok &&
        (before?.probe.ok === false || (before?.probe.p50 ?? Number.POSITIVE_INFINITY) >= (nowStats.p50 ?? 0)) &&
        nowStats.errors === 0 &&
        (nowStats.p50 ?? Infinity) < 1500 &&
        (before?.memory ? nowStats.memory !== null && nowStats.memory.last < before.memory.last : true);

      const verdict = improved ? fa.fixed : nowStats.ok ? fa.cannotVerify : fa.notFixed;
      const text = [
        `🔎 بررسی پس از اصلاح — رخداد ${incidentId}`,
        table,
        "",
        verdict,
        nowStats.ok
          ? `✅ سلامت: ${probeOk?.samples.map((s) => s.status).join("، ")} — p50=${nowStats.p50 ?? "—"}ms`
          : "❌ پروب سلامت موفق نبود.",
        baseline?.errorPattern ? `🔎 الگوی خطای قبلی: ${baseline.errorPattern}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      return result(text, {
        ok: true,
        incidentId,
        verified: improved,
        before: before ?? null,
        after: nowStats,
      });
    },
  );

  /* ── connect_domain ──────────────────────────────────────────────── */
  server.registerTool(
    "connect_domain",
    {
      title: "اتصال دامنه به اپ",
      description:
        "ثبت دامنه روی اپ (نیازمند تأیید)، نمایش رکوردهای DNS، بررسی وضعیت DNS و فعال‌سازی SSL (نیازمند تأیید). ثبت دامنه در IRNIC دستی است.",
      inputSchema: {
        app: z.string().min(1).describe("نام اپ در لیارا"),
        domain: z.string().min(3).describe("نام دامنه"),
      },
      annotations: COMPOSITE_ANNOTATIONS,
    },
    async ({ app, domain }) => {
      const lines: string[] = [];
      lines.push(
        `${fa.apiLimitation("ثبت دامنه در ایرنیک (IRNIC) دستی است؛ این ابزار فقط دامنه را به اپ لیارا وصل می‌کند.")}`,
      );

      const out = await runGuardedAction("liara_add_domain", { app, domain });
      const text = out.res.content?.[0]?.type === "text" ? out.res.content[0].text : "";
      lines.push(text);
      if (!out.executed) {
        lines.push("ℹ️ بدون تأیید، هیچ تغییری روی لیارا اعمال نشد.");
        return result(lines.join("\n"), { ok: false, ...(out.res.structuredContent ?? {}) });
      }

      const records = (out.res.structuredContent as { dnsRecords?: { type: string; name: string; value: string }[] })
        ?.dnsRecords ?? [];

      // بررسی وضعیت DNS
      let domainId: string | undefined;
      try {
        const res = await liaraGet<unknown>(EP.listDomains, { query: { project: app } });
        const rows = Array.isArray(res.data) ? res.data : (res.data as { domains?: unknown[] })?.domains ?? [];
        const found = (rows as Record<string, unknown>[]).find(
          (r) => String(r?.["name"] ?? "").toLowerCase() === domain.toLowerCase(),
        );
        domainId = found ? String(found["id"] ?? found["domainID"] ?? found["_id"] ?? "") : undefined;
        if (domainId) {
          const check = await liaraGet<unknown>(EP.checkDomain(domainId));
          lines.push(`🔎 وضعیت DNS: ${JSON.stringify(check.data).slice(0, 300)}`);
        }
      } catch {
        lines.push("🔎 بررسی وضعیت DNS ناموفق بود (دامنه شاید هنوز ثبت نشده باشد).");
      }

      if (records.length) {
        lines.push("📋 رکوردهای DNS موردنیاز (در پنل DNS دامنه ثبت کنید):");
        for (const r of records) lines.push(`• ${r.type} ${r.name} → ${r.value}`);
      }

      // فعال‌سازی SSL
      const ssl = await runGuardedAction("liara_enable_ssl", { domain });
      const sslText = ssl.res.content?.[0]?.type === "text" ? ssl.res.content[0].text : "";
      lines.push(sslText);

      lines.push("ℹ️ پس از ثبت رکوردهای DNS، با liara_status وضعیت SSL را بررسی کنید.");
      return result(lines.join("\n"), {
        ok: true,
        app,
        domain,
        dnsRecords: records,
        domainId,
      });
    },
  );

  /* ── watch_after_deploy ──────────────────────────────────────────── */
  server.registerTool(
    "watch_after_deploy",
    {
      title: "پایش کوتاه‌مدت پس از استقرار",
      description:
        "به‌مدت ۲ دقیقه، پروب سلامت و متریک‌ها را پایش می‌کند و هر ۱۵ ثانیه گزارش می‌دهد (کار خودکار کم‌ریسک پس از دیپلوی).",
      inputSchema: {
        app: z.string().min(1).describe("نام اپ در لیارا"),
        minutes: z.number().int().min(1).max(5).default(2).describe("مدت پایش به دقیقه"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ app, minutes }) => {
      const lines: string[] = [`👀 پایش «${app}» به‌مدت ${minutes} دقیقه...`];
      const deadline = Date.now() + minutes * 60_000;
      let healthy = 0;
      let checks = 0;
      const metrics: unknown[] = [];
      while (Date.now() < deadline) {
        const probe = await httpProbe(app, { path: "/health", count: 1 });
        try {
          const summary = await liaraGet(EP.metricsSummary(app));
          metrics.push({ at: new Date().toISOString(), summary: summary.data });
        } catch { metrics.push({ at: new Date().toISOString(), available: false }); }
        checks += 1;
        if ("error" in probe) {
          lines.push(`• ${faTime(new Date().toISOString())} — ❌ ${probe.error}`);
        } else {
          if (probe.ok) healthy += 1;
          lines.push(
            `• ${faTime(new Date().toISOString())} — ${probe.ok ? "✅" : "❌"} ${probe.samples[0]?.status ?? "—"} در ${probe.p50 ?? "—"}ms`,
          );
        }
        await sleep(15_000);
      }
      lines.push(
        `📊 خلاصه: ${healthy}/${checks} بررسی سالم بود.`,
        healthy === checks
          ? "✅ سرویس در کل بازهٔ پایش پایدار بود."
          : "⚠️ ناپایداری مشاهده شد — diagnose را اجرا کنید.",
      );
      return result(lines.join("\n"), { ok: true, app, healthy, checks, metrics });
    },
  );

  /* ── Tier C: راهنماها ────────────────────────────────────────────── */

  server.registerTool(
    "guide_domain_registration",
    {
      title: "راهنمای ثبت دامنه (IRNIC)",
      description:
        "مرحله‌به‌مرحلهٔ ثبت دامنه در IRNIC و اتصال آن به لیارا — چون API لیارا امکان خرید/ثبت دامنه ندارد.",
      inputSchema: {
        domain: z.string().optional().describe("دامنهٔ هدف (اختیاری)"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ domain }) =>
      result(
        [
          `${fa.apiLimitation("API لیارا دامنه ثبت/خریداری نمی‌کند؛ ثبت دامنه در IRNIC انجام می‌شود.")}`,
          "📋 گام‌ها:",
          "1) وارد irnic.ir شوید و یک دامنهٔ آزاد (.ir یا نام تجاری) جست‌وجو و خریداری کنید.",
          "2) در پنل دامنه، نام سرور (Name Server) را روی NSهای لیارا تنظیم کنید.",
          "3) سپس connect_domain را اجرا کنید تا دامنه به اپ وصل شود.",
          "4) رکوردهای DNS اعلام‌شده توسط لیارا (CNAME/A) را در پنل دامنه ثبت کنید.",
          "5) بررسی DNS: GET /v1/domains/{id}/check — و سپس فعال‌سازی SSL.",
          domain ? `🎯 دامنهٔ هدف: ${domain}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        { ok: true },
      ),
  );

  server.registerTool(
    "guide_rollback",
    {
      title: "راهنمای بازگشت به نسخهٔ قبلی",
      description:
        "لیارا endpoint رول‌بک ندارد؛ راه‌حل: پیدا کردن انتشار موفق قبلی و دیپلوی دوبارهٔ همان سورس (با تأیید).",
      inputSchema: {
        app: z.string().min(1).describe("نام اپ در لیارا"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ app }) => {
      try {
        const { data } = await liaraGet<unknown>(EP.listReleases(app));
        const rows = Array.isArray(data)
          ? data
          : ((data as { data?: unknown[] })?.data ?? []);
        const lines = rows.slice(-10).map((r) => {
          const o = (r ?? {}) as Record<string, unknown>;
          const id = String(o["releaseID"] ?? o["id"] ?? "—");
          const status = String(o["status"] ?? o["state"] ?? "—");
          const created = o["created_at"] ? faTime(String(o["created_at"])) : "—";
          const source = String(o["sourceID"] ?? o["source"] ?? "");
          return `• ${id} — ${status} — ${created}${source ? ` — source: ${source}` : ""}`;
        });
        return result(
          [
            `${fa.apiLimitation("endpoint رول‌بک در API لیارا وجود ندارد؛ باید سورس نسخهٔ قبلی دوباره دیپلوی شود.")}`,
            `📜 انتشارهای «${app}»:`,
            bullets(lines),
            "▶️ گام بعدی: آخرین انتشار موفق را انتخاب کنید و liara_deploy را با همان سورس اجرا کنید (تأیید لازم است).",
          ].join("\n"),
          { ok: true, app, releases: rows },
        );
      } catch (err) {
        return result(`❌ دریافت انتشارها ناموفق بود: ${(err as Error).message}`, { ok: false });
      }
    },
  );

  server.registerTool(
    "guide_github_deploy",
    {
      title: "راهنمای دیپلوی از گیت‌هاب",
      description:
        "لیارا دیپلوی مستقیم از گیت‌هاب ندارد؛ به‌جای آن یک GitHub Action آماده برای اجرای liara deploy تولید می‌شود.",
      inputSchema: {
        app: z.string().default("agate-liara").describe("نام اپ در لیارا"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ app }) => {
      const workflow = `name: Deploy to Liara

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install Liara CLI
        run: npm install -g @liara/cli
      - name: Deploy
        env:
          LIARA_API_TOKEN: \${{ secrets.LIARA_API_TOKEN }}
        run: liara deploy --api-token=\$LIARA_API_TOKEN --app=${app} --platform node --port 3000 --detach
`;
      return result(
        [
          `${fa.apiLimitation("دیپلوی مستقیم از گیت‌هاب در API لیارا وجود ندارد؛ از GitHub Action استفاده کنید.")}`,
          "📄 فایل `.github/workflows/liara.yml`:",
          "```yaml",
          workflow.trim(),
          "```",
          "🔐 توکن را در Settings → Secrets → Actions با نام LIARA_API_TOKEN ذخیره کنید (هرگز داخل مخزن نگذارید).",
        ].join("\n"),
        { ok: true, workflow },
      );
    },
  );
}

function seriesStats(s: Series): { min: number; max: number; avg: number; last: number } {
  const values = s.points.map((p) => p.value);
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    avg: values.reduce((a, b) => a + b, 0) / values.length,
    last: values[values.length - 1]!,
  };
}

function round(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}
