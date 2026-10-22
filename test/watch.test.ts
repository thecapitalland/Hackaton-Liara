/**
 * تست‌های حالت پایش: آستانه‌ها، رویدادها، cooldown، ممیزی و سیاست تأیید.
 *
 * این تست‌ها به شبکه/لیارا وصل نمی‌شوند؛ probe، متریک، رویداد، diagnose و
 * اقدام درمانی تزریق می‌شوند.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { decideApproval } from "../src/approval.js";
import type { AuditEntry } from "../src/audit.js";
import { result } from "../src/tools/common.js";
import type { DiagnosisOptions, DiagnosisRun } from "../src/tools/composite.js";
import type { GuardedOutcome } from "../src/tools/write.js";
import type { EventItem, IncidentReport, ProbeResult } from "../src/types.js";
import {
  computeWatchStats,
  detectWatchTriggers,
  eventTimestampSec,
  isRestartEvent,
  remediationAudit,
  routeResult,
  runWatchCheck,
  summaryNumber,
  triggersFingerprint,
  watchProbeResult,
  type WatchRemediationContext,
  type WatchSnapshot,
} from "../src/watch.js";

const app = "agate-liara";

function probe(statuses: (number | null)[], p50: number): ProbeResult {
  return {
    url: `https://${app}.liara.run/`,
    samples: statuses.map((status) => ({ status, latencyMs: p50 })),
    ok: statuses.every((status) => (status ?? 0) >= 200 && (status ?? 0) < 300),
    p50,
  };
}

function snapshot(routes: ReturnType<typeof routeResult>[], overrides: Partial<WatchSnapshot> = {}): WatchSnapshot {
  return {
    at: "2026-10-22T12:00:00.000Z",
    routes,
    ...computeWatchStats(routes),
    metrics: { available: true, cpu: 1, memory: 40 },
    events: [],
    eventsAvailable: true,
    limitations: [],
    ...overrides,
  };
}

function diagnosis(
  selectedRemedy: DiagnosisRun["selectedRemedy"] = "restart",
  rollbackAvailable = false,
): DiagnosisRun {
  const report: IncidentReport = {
    incidentId: "inc_test",
    provider: "liara",
    appId: app,
    observedAt: "2026-10-22T12:00:00.000Z",
    status: "diagnosed",
    evidence: [],
    hypotheses: [
      {
        id: "http_5xx",
        rank: 1,
        cause: "خطای داخلی سرویس",
        confidence: 0.8,
        evidenceIds: ["ev_probe_1"],
        kind: "observed",
        remedies: ["code_fix", "restart"],
        remedyText: ["اصلاح کد"],
      },
    ],
    selectedRemedy,
    remedySource: "rules",
    rollbackAvailable,
    limitations: [],
  };
  return {
    report,
    text: "🧠 منبع تحلیل: fallback قانون‌محور\nگزارش تشخیص تست",
    analysisLine: "🧠 منبع تحلیل: fallback قانون‌محور",
    llmUsed: false,
    selectedRemedy,
    remedySource: "rules",
    rollbackAvailable,
  };
}

function automaticRemediation(): GuardedOutcome {
  return {
    res: result("🤖 اجرای خودکار طبق سیاست balanced", {
      ok: true,
      approvalMode: "automatic",
      approvalPolicy: "balanced",
    }),
    executed: true,
  };
}

test("نرخ 500 و p50 فقط بالای آستانه‌ها هشدار می‌دهند", () => {
  const routes = [
    routeResult("/", probe([500, 500, 500], 3200)),
    routeResult("/api/challenges", probe([200, 200, 200], 900)),
    routeResult("/api/status", probe([200, 200, 200], 200)),
  ];
  const stats = computeWatchStats(routes);
  assert.equal(stats.totalSamples, 9);
  assert.equal(stats.count500, 3);
  assert.ok(Math.abs(stats.rate500Pct - 100 / 3) < 1e-9);
  assert.equal(stats.maxP50, 3200);
  assert.equal(stats.maxP50Path, "/");

  const triggers = detectWatchTriggers(snapshot(routes), []);
  assert.deepEqual(triggers.map((t) => t.code), ["error500", "slow"]);

  // ۵٪ دقیقاً آستانه است، نه «بالاتر از آستانه»؛ ۱۵۰۰ms هم دقیقاً آستانه است.
  const atThreshold = snapshot([
    routeResult("/", probe([500, 200, 200], 1500)),
  ]);
  assert.ok(Math.abs(atThreshold.rate500Pct - 100 / 3) < 1e-9);
  const noFalsePositive = detectWatchTriggers(
    { ...atThreshold, rate500Pct: 5, totalSamples: 20, count500: 1 },
    [],
  );
  assert.equal(noFalsePositive.length, 0);
});

test("watchProbeResult همان ۹ نمونه و ۳ خطای ۵۰۰ چرخه را می‌سازد", () => {
  const routes = [
    routeResult("/", probe([500, 500, 500], 3200)),
    routeResult("/api/challenges", probe([200, 200, 200], 900)),
    routeResult("/api/status", probe([200, 200, 200], 200)),
  ];
  const p = watchProbeResult(app, snapshot(routes));
  assert.equal(p.samples.length, 9);
  assert.equal(p.samples.filter((s) => s.status === 500).length, 3);
  assert.equal(p.p50, 3200);
  assert.equal(p.ok, false);
  assert.equal(p.url, `https://${app}.liara.run/`);
});

test("diagnose نمونه‌های همان چرخه و انتخاب راهکار را دریافت می‌کند", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "agate-watch-probe-"));
  try {
    let capturedOptions: DiagnosisOptions | undefined;
    let capturedRemediation: WatchRemediationContext | undefined;
    const result = await runWatchCheck({
      app,
      stateDir,
      cooldownSec: 60,
      deps: {
        now: () => new Date("2026-10-22T12:00:00.000Z"),
        probeRoute: async (_target: string, routePath: string): Promise<ProbeResult> =>
          routePath === "/" ? probe([500, 500, 500], 100) : probe([200, 200, 200], 100),
        readMetrics: async () => ({ available: true, cpu: 1, memory: 40 }),
        readEvents: async () => [],
        diagnose: async (_app, _symptom, options) => {
          capturedOptions = options;
          return diagnosis("rollback_last_env_change", true);
        },
        remediate: async (_app, context) => {
          capturedRemediation = context;
          return automaticRemediation();
        },
        audit: () => undefined,
      },
    });

    assert.ok(result.incident);
    assert.equal(capturedOptions?.probe?.samples.length, 9);
    assert.equal(capturedOptions?.probe?.samples.filter((s) => s.status === 500).length, 3);
    assert.equal(capturedOptions?.probe?.p50, 100);
    assert.equal(capturedOptions?.eventWindowMinutes, 10);
    assert.equal(capturedOptions?.incidentAt, "2026-10-22T12:00:00.000Z");
    assert.equal(capturedRemediation?.selectedRemedy, "rollback_last_env_change");
    assert.equal(capturedRemediation?.rollbackAvailable, true);
    assert.equal(result.incident.remediation?.kind, "rollback_last_env_change");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("خلاصهٔ متریک شکل رسمی Reports و مقدار ساده را بدون حدس واحد می‌خواند", () => {
  assert.equal(
    summaryNumber([
      { value: [1792700000, "0.0003"], applet: "a" },
      { value: [1792700100, "0.0004"], applet: "a" },
    ]),
    0.0004,
  );
  assert.equal(summaryNumber([{ value: [1792700000, 29818880], applet: "a" }]), 29818880);
  assert.equal(summaryNumber("42"), 42);
  assert.equal(summaryNumber(null), null);
});

test("رویداد OOM/ری‌استارت تشخیص داده می‌شود و timestamp ثانیه‌ای/ایزو parse می‌شود", () => {
  assert.equal(isRestartEvent({ ts: null, type: "oom", message: "out of memory" }), true);
  assert.equal(isRestartEvent({ ts: null, type: "OOMKilled", message: "OOMKilled" }), true);
  assert.equal(isRestartEvent({ ts: null, type: "restart", message: "service restarted" }), true);
  assert.equal(isRestartEvent({ ts: null, type: "crash", message: "process crashed" }), true);
  // چرخهٔ عادی release در لیارا این وضعیت‌ها را هم تولید می‌کند و نباید هشدار باشد.
  assert.equal(isRestartEvent({ ts: null, type: "kill", message: "kill" }), false);
  assert.equal(isRestartEvent({ ts: null, type: "die", message: "process died" }), false);
  assert.equal(isRestartEvent({ ts: null, type: "destroy", message: "destroy" }), false);
  assert.equal(isRestartEvent({ ts: null, type: "info", message: "request ok" }), false);
  const healthy = snapshot([routeResult("/", probe([200, 200, 200], 100))]);
  assert.deepEqual(
    detectWatchTriggers(healthy, [{ ts: null, type: "destroy", message: "destroy" }]),
    [],
  );

  assert.equal(eventTimestampSec({ ts: "1792680000", type: "kill", message: "" }), 1792680000);
  assert.equal(
    eventTimestampSec({ ts: "2026-10-22T12:00:00.000Z", type: "kill", message: "" }),
    1792670400,
  );
  assert.equal(eventTimestampSec({ ts: null, type: "kill", message: "" }), null);
});

test("امضای triggerها برای cooldown پایدار است", () => {
  assert.equal(
    triggersFingerprint([
      { code: "slow", path: "/", detail: "a" },
      { code: "error500", detail: "b" },
    ]),
    "error500:|slow:/",
  );
});

test("cooldown از هشدار تکراری جلوگیری می‌کند و بعد از آن رخداد تازه ثبت می‌شود", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "agate-watch-"));
  try {
    let now = new Date("2026-10-22T12:00:00.000Z");
    let diagnoseCalls = 0;
    let remediateCalls = 0;
    const audits: AuditEntry[] = [];

    const badRoutes = async (target: string, routePath: string): Promise<ProbeResult> =>
      routePath === "/api/status" ? probe([200, 200, 200], 100) : probe([500, 500, 500], 3200);

    const deps = {
      now: () => now,
      probeRoute: badRoutes,
      readMetrics: async () => ({ available: true, cpu: 2, memory: 44 }),
      readEvents: async () => [],
      diagnose: async () => {
        diagnoseCalls += 1;
        return diagnosis();
      },
      remediate: async () => {
        remediateCalls += 1;
        return automaticRemediation();
      },
      audit: (entry: AuditEntry) => audits.push(entry),
    };

    const first = await runWatchCheck({
      app,
      stateDir,
      cooldownSec: 60,
      deps,
      remediate: true,
    });
    assert.ok(first.incident);
    assert.equal(first.cooldown.active, false);
    assert.equal(diagnoseCalls, 1);
    assert.equal(remediateCalls, 1);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.tool, "watch_incident");
    assert.equal(audits[0]?.approval, "auto:balanced");
    assert.equal(audits[0]?.result, "ok");
    assert.match(audits[0]?.detail ?? "", new RegExp(first.incident!.incidentId));

    now = new Date("2026-10-22T12:00:30.000Z");
    const during = await runWatchCheck({
      app,
      stateDir,
      cooldownSec: 60,
      deps,
      remediate: true,
    });
    assert.equal(during.cooldown.active, true);
    assert.equal(during.incident, null);
    assert.equal(diagnoseCalls, 1);
    assert.equal(remediateCalls, 1);
    assert.equal(audits.length, 1);
    assert.match(during.reportFa, /cooldown/);

    now = new Date("2026-10-22T12:01:01.000Z");
    const after = await runWatchCheck({
      app,
      stateDir,
      cooldownSec: 60,
      deps,
      remediate: true,
    });
    assert.ok(after.incident);
    assert.notEqual(after.incident.incidentId, first.incident!.incidentId);
    assert.equal(diagnoseCalls, 2);
    assert.equal(remediateCalls, 2);
    assert.equal(audits.length, 2);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("cooldown فقط مشکل تکراری را خفه می‌کند، نه رخداد متفاوت", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "agate-watch-different-"));
  try {
    let now = new Date("2026-10-22T12:00:00.000Z");
    let mode: "error" | "slow" = "error";
    let diagnoseCalls = 0;
    const deps = {
      now: () => now,
      probeRoute: async (_target: string, routePath: string): Promise<ProbeResult> => {
        if (mode === "error") {
          return routePath === "/api/status" ? probe([200, 200, 200], 100) : probe([500, 500, 500], 100);
        }
        return routePath === "/" ? probe([200, 200, 200], 2100) : probe([200, 200, 200], 100);
      },
      readMetrics: async () => ({ available: true, cpu: 1, memory: 40 }),
      readEvents: async () => [],
      diagnose: async () => {
        diagnoseCalls += 1;
        return diagnosis();
      },
      remediate: async () => automaticRemediation(),
      audit: () => undefined,
    };

    const first = await runWatchCheck({ app, stateDir, deps, cooldownSec: 60 });
    assert.deepEqual(first.triggers.map((t) => t.code), ["error500"]);
    assert.ok(first.incident);

    now = new Date("2026-10-22T12:00:20.000Z");
    mode = "slow";
    const different = await runWatchCheck({ app, stateDir, deps, cooldownSec: 60 });
    assert.deepEqual(different.triggers.map((t) => t.code), ["slow"]);
    assert.equal(different.cooldown.active, false);
    assert.ok(different.incident);
    assert.equal(diagnoseCalls, 2);

    now = new Date("2026-10-22T12:00:30.000Z");
    const duplicate = await runWatchCheck({ app, stateDir, deps, cooldownSec: 60 });
    assert.equal(duplicate.cooldown.active, true);
    assert.equal(duplicate.incident, null);
    assert.equal(diagnoseCalls, 2);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("اولین چرخه رویدادهای قدیمی را هشدار نمی‌دهد؛ فقط رویداد جدید trigger است", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "agate-watch-events-"));
  try {
    let now = new Date("2026-10-22T12:00:00.000Z");
    const oldEvent: EventItem = {
      ts: "2026-10-22T11:59:00.000Z",
      type: "kill",
      message: "old restart",
    };
    const newEvent: EventItem = {
      ts: "2026-10-22T12:00:15.000Z",
      type: "oom",
      message: "out of memory",
    };
    let events = [oldEvent];
    let diagnoseCalls = 0;
    const deps = {
      now: () => now,
      probeRoute: async () => probe([200, 200, 200], 120),
      readMetrics: async () => ({ available: true, cpu: 1, memory: 40 }),
      readEvents: async () => events,
      diagnose: async () => {
        diagnoseCalls += 1;
        return diagnosis();
      },
      remediate: async () => automaticRemediation(),
      audit: () => undefined,
    };

    const first = await runWatchCheck({ app, stateDir, deps, cooldownSec: 60 });
    assert.equal(first.triggers.length, 0);
    assert.equal(first.incident, null);

    now = new Date("2026-10-22T12:00:10.000Z");
    const second = await runWatchCheck({ app, stateDir, deps, cooldownSec: 60 });
    assert.equal(second.triggers.length, 0);
    assert.equal(second.incident, null);

    events = [oldEvent, newEvent];
    now = new Date("2026-10-22T12:00:20.000Z");
    const third = await runWatchCheck({ app, stateDir, deps, cooldownSec: 60 });
    assert.equal(third.triggers.some((t) => t.code === "restart"), true);
    assert.ok(third.incident);
    assert.equal(diagnoseCalls, 1);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("اقدام rollback از همان سیاست تأیید عبور می‌کند: strict تأیید، balanced low خودکار", () => {
  const params = { app, incidentAt: "2026-10-23T12:00:00.000Z" };

  const strict = decideApproval({
    tool: "rollback_last_env_change",
    params,
    declaredRisk: "low",
    policy: "strict",
  });
  assert.equal(strict.requiresApproval, true);
  assert.equal(strict.automatic, false);

  const balanced = decideApproval({
    tool: "rollback_last_env_change",
    params,
    declaredRisk: "low",
    policy: "balanced",
  });
  assert.equal(balanced.risk, "low");
  assert.equal(balanced.requiresApproval, false);
  assert.equal(balanced.automatic, true);
  assert.match(balanced.autoNoticeFa ?? "", /balanced/);

  const setEnv = decideApproval({
    tool: "liara_set_env",
    params: { app, variables: [{ key: "BUG_MODE", value: "off" }] },
    declaredRisk: "medium",
    policy: "balanced",
  });
  assert.equal(setEnv.risk, "medium");
  assert.equal(setEnv.requiresApproval, true);
});

test("نتیجهٔ اقدام در ممیزی: pending، auto:balanced و approved درست نگاشت می‌شوند", () => {
  const pending: GuardedOutcome = {
    res: result("نیازمند تأیید", {
      ok: false,
      code: "APPROVAL_REQUIRED",
      approval: { approvalId: "a1" },
    }),
    executed: false,
    approvalId: "a1",
  };
  assert.equal(remediationAudit(pending), "pending");

  assert.equal(remediationAudit(automaticRemediation()), "auto:balanced");

  const approved: GuardedOutcome = {
    res: result("انجام شد", { ok: true }),
    executed: true,
  };
  assert.equal(remediationAudit(approved), "approved");
  assert.equal(remediationAudit(null), "not-required");
});
