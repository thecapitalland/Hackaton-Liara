/**
 * تست‌های تاریخچهٔ محلی env و کشف آخرین تغییر.
 *
 * هدف: rollback فقط همان تغییر env را برگرداند؛ تغییر قدیمی/خارج از پنجره،
 * رکورد خود rollback، و متادیتای audit/release نباید باعث بازگردانی کورکورانه شوند.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AuditEntry } from "../src/audit.js";
import {
  BASELINE_MAX_P50_MS,
  diffEnv,
  envBaselinePath,
  envDiffSummary,
  findBaselineRollbackInfo,
  findLatestEnvChange,
  isHealthyProbe,
  loadEnvBaseline,
  loadEnvHistory,
  recordEnvChange,
  saveEnvBaseline,
  type EnvVar,
} from "../src/env-history.js";

const app = "agate-liara";

function iso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

function withStateDir(fn: (stateDir: string) => Promise<void> | void): Promise<void> {
  const stateDir = mkdtempSync(path.join(tmpdir(), "agate-env-history-"));
  return Promise.resolve(fn(stateDir)).finally(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });
}

test("diffEnv فقط کلیدهای واقعاً تغییر‌یافته را برمی‌گرداند", () => {
  const before: EnvVar[] = [
    { key: "A", value: "1" },
    { key: "B", value: "2" },
    { key: "EMPTY", value: "" },
  ];
  const after: EnvVar[] = [
    { key: "A", value: "9" },
    { key: "B", value: "2" },
    { key: "EMPTY", value: "" },
    { key: "C", value: "3" },
  ];
  assert.deepEqual(diffEnv(before, after), [
    { key: "A", before: "1", after: "9" },
    { key: "C", before: null, after: "3" },
  ]);
  assert.deepEqual(diffEnv(before, before), []);
});

test("آخرین تغییر env دقیقاً با before/after بازگردانی‌پذیر است", async () => {
  await withStateDir(async (stateDir) => {
    const before: EnvVar[] = [
      { key: "A", value: "1" },
      { key: "B", value: "2" },
    ];
    const after: EnvVar[] = [
      { key: "A", value: "9" },
      { key: "C", value: "3" },
    ];
    const record = recordEnvChange(app, before, after, { at: iso(60_000), stateDir });
    assert.ok(record);
    assert.equal(loadEnvHistory(app, stateDir).length, 1);

    const found = await findLatestEnvChange(app, new Date(), {
      stateDir,
      includeReleases: false,
      auditEntries: [],
    });
    assert.ok(found);
    assert.equal(found.source, "journal");
    assert.equal(found.revertable, true);
    assert.equal(found.id, record!.id);
    assert.deepEqual(found.changes, [
      { key: "A", before: "1", after: "9" },
      { key: "B", before: "2", after: null },
      { key: "C", before: null, after: "3" },
    ]);
  });
});

test("audit با کلیدهای بدون تغییر، journal دقیق را خفه نمی‌کند", async () => {
  await withStateDir(async (stateDir) => {
    recordEnvChange(app, [{ key: "A", value: "1" }], [{ key: "A", value: "2" }], {
      at: iso(60_000),
      stateDir,
    });
    const entry: AuditEntry = {
      ts: iso(30_000),
      tool: "liara_set_env",
      app,
      params: {
        app,
        variables: [
          { key: "A", value: "••••" },
          { key: "UNCHANGED", value: "••••" },
        ],
      },
      approval: "approved",
      result: "ok",
      durationMs: 2,
    };
    const found = await findLatestEnvChange(app, new Date(), {
      stateDir,
      includeReleases: false,
      auditEntries: [entry],
    });
    assert.ok(found);
    assert.equal(found.source, "journal");
    assert.equal(found.revertable, true);
    assert.deepEqual(found.changes, [{ key: "A", before: "1", after: "2" }]);
  });
});

test("تغییر env قدیمی‌تر از پنجرهٔ ۱۰ دقیقه نادیده گرفته می‌شود", async () => {
  await withStateDir(async (stateDir) => {
    recordEnvChange(app, [{ key: "OLD", value: "1" }], [{ key: "OLD", value: "2" }], {
      at: iso(20 * 60_000),
      stateDir,
    });
    const found = await findLatestEnvChange(app, new Date(), {
      stateDir,
      includeReleases: false,
      auditEntries: [],
    });
    assert.equal(found, null);
  });
});

test("آخرین رکورد rollback دوباره کاندید نمی‌شود (جلوگیری از حلقه)", async () => {
  await withStateDir(async (stateDir) => {
    recordEnvChange(app, [{ key: "A", value: "on" }], [{ key: "A", value: "off" }], {
      at: iso(120_000),
      stateDir,
    });
    recordEnvChange(app, [{ key: "A", value: "off" }], [{ key: "A", value: "on" }], {
      at: iso(60_000),
      kind: "rollback",
      stateDir,
    });

    const found = await findLatestEnvChange(app, new Date(), {
      stateDir,
      includeReleases: false,
      auditEntries: [],
    });
    assert.equal(found, null);
  });
});

test("audit فقط متادیتای تغییر را می‌دهد و revertable نیست", async () => {
  await withStateDir(async (stateDir) => {
    const entry: AuditEntry = {
      ts: iso(60_000),
      tool: "liara_set_env",
      app,
      params: {
        app,
        variables: [{ key: "FEATURE_FLAG", value: "••••" }],
        unset: ["OLD_FLAG"],
      },
      approval: "approved",
      result: "ok",
      durationMs: 3,
    };
    const found = await findLatestEnvChange(app, new Date(), {
      stateDir,
      includeReleases: false,
      auditEntries: [entry],
    });
    assert.ok(found);
    assert.equal(found.source, "audit");
    assert.equal(found.revertable, false);
    assert.deepEqual(found.keys, ["FEATURE_FLAG", "OLD_FLAG"]);
    assert.deepEqual(found.changes, []);
  });
});

test("آخرین تغییر بین journal و audit انتخاب می‌شود؛ audit جدیدتر بازگردانی کور نمی‌کند", async () => {
  await withStateDir(async (stateDir) => {
    recordEnvChange(app, [{ key: "A", value: "1" }], [{ key: "A", value: "2" }], {
      at: iso(120_000),
      stateDir,
    });
    const entry: AuditEntry = {
      ts: iso(30_000),
      tool: "liara_set_env",
      app,
      params: { app, variables: [{ key: "B", value: "••••" }] },
      approval: "approved",
      result: "ok",
      durationMs: 2,
    };
    const found = await findLatestEnvChange(app, new Date(), {
      stateDir,
      includeReleases: false,
      auditEntries: [entry],
    });
    assert.ok(found);
    assert.equal(found.source, "audit");
    assert.equal(found.revertable, false);
  });
});

test("release ENV_UPDATE فقط متادیتا است و بدون مقدار قبلی rollback نمی‌شود", async () => {
  await withStateDir(async (stateDir) => {
    const found = await findLatestEnvChange(app, new Date(), {
      stateDir,
      auditEntries: [],
      releases: [
        {
          _id: "rel_1",
          type: "ENV_UPDATE",
          createdAt: iso(45_000),
        },
      ],
    });
    assert.ok(found);
    assert.equal(found.source, "release");
    assert.equal(found.revertable, false);
    assert.deepEqual(found.changes, []);
    assert.equal(found.releaseId, "rel_1");
  });
});

test("baseline سالم منبع سوم rollback است و diff اضافه/حذف/تغییر می‌سازد", async () => {
  await withStateDir(async (stateDir) => {
    const baselineAt = iso(120_000);
    saveEnvBaseline(
      app,
      [
        { key: "BUG_MODE", value: "off" },
        { key: "B", value: "2" },
        { key: "REMOVED", value: "old" },
      ],
      { stateDir, at: baselineAt },
    );
    assert.ok(loadEnvBaseline(app, stateDir));
    assert.equal(loadEnvBaseline(app, stateDir)?.capturedAt, baselineAt);

    const found = await findLatestEnvChange(app, new Date(), {
      stateDir,
      auditEntries: [],
      includeBaseline: true,
      releases: [
        { _id: "rel_env", type: "ENV_UPDATE", createdAt: iso(60_000) },
      ],
      currentEnvs: [
        { key: "BUG_MODE", value: "error500" },
        { key: "B", value: "2" },
        { key: "ADDED", value: "new" },
      ],
    });
    assert.ok(found);
    assert.equal(found.source, "baseline");
    assert.equal(found.revertable, true);
    assert.equal(found.releaseId, "rel_env");
    assert.equal(found.baselineAt, baselineAt);
    assert.deepEqual(found.changes, [
      { key: "ADDED", before: null, after: "new" },
      { key: "BUG_MODE", before: "off", after: "error500" },
      { key: "REMOVED", before: "old", after: null },
    ]);
    assert.deepEqual(found.diff, {
      added: ["ADDED"],
      removed: ["REMOVED"],
      changed: ["BUG_MODE"],
    });
    assert.deepEqual(envDiffSummary(found.changes), found.diff);

    const info = await findBaselineRollbackInfo(app, new Date(), {
      stateDir,
      releases: [{ _id: "rel_env", type: "ENV_UPDATE", createdAt: iso(60_000) }],
    });
    assert.ok(info);
    assert.equal(info.releaseId, "rel_env");
    assert.equal(info.baselineAt, baselineAt);
  });
});

test("بدون baseline، ENV_UPDATE فقط متادیتا می‌ماند و منبع قابل‌بازگشت نیست", async () => {
  await withStateDir(async (stateDir) => {
    const found = await findLatestEnvChange(app, new Date(), {
      stateDir,
      auditEntries: [],
      includeBaseline: true,
      baseline: null,
      currentEnvs: [],
      releases: [
        { _id: "rel_no_base", type: "ENV_UPDATE", createdAt: iso(30_000) },
      ],
    });
    assert.ok(found);
    assert.equal(found.source, "release");
    assert.equal(found.revertable, false);
    assert.deepEqual(found.changes, []);
    assert.equal(
      await findBaselineRollbackInfo(app, new Date(), {
        stateDir,
        baseline: null,
        releases: [{ _id: "rel_no_base", type: "ENV_UPDATE", createdAt: iso(30_000) }],
      }),
      null,
    );
  });
});

test("baseline با mode 0600 و بدون مقدار در diff summary ذخیره می‌شود", async () => {
  await withStateDir(async (stateDir) => {
    saveEnvBaseline(app, [{ key: "SECRET", value: "test-only-secret" }], { stateDir });
    const file = envBaselinePath(app, stateDir);
    const loaded = loadEnvBaseline(app, stateDir);
    assert.equal(loaded?.env[0]?.value, "test-only-secret");
    if (process.platform !== "win32") {
      assert.equal(statSync(file).mode & 0o777, 0o600);
    }
    const summary = envDiffSummary([
      { key: "SECRET", before: "test-only-secret", after: "x" },
      { key: "NEW", before: null, after: "test-only-secret" },
    ]);
    assert.deepEqual(summary, { added: ["NEW"], removed: [], changed: ["SECRET"] });
  });
});

test("آستانهٔ سالم بودن baseline: ۰ خطای ۵۰۰، همهٔ نمونه‌ها 2xx و p50 عادی", () => {
  const healthy = {
    url: `https://${app}.liara.run/`,
    samples: [
      { status: 200, latencyMs: 120 },
      { status: 200, latencyMs: 200 },
      { status: 200, latencyMs: 180 },
    ],
    ok: true,
    p50: 180,
  };
  assert.equal(isHealthyProbe(healthy), true);

  assert.equal(
    isHealthyProbe({ ...healthy, samples: [{ status: 500, latencyMs: 100 }], p50: 100 }),
    false,
  );
  assert.equal(isHealthyProbe({ ...healthy, p50: BASELINE_MAX_P50_MS + 1 }), false);
  assert.equal(
    isHealthyProbe({ ...healthy, samples: [{ status: 404, latencyMs: 100 }], p50: 100 }),
    false,
  );
  assert.equal(isHealthyProbe({ error: "timeout" }), false);
});
