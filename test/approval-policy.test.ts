/**
 * تست‌های سیاست تأیید (APPROVAL_POLICY) و ثبت ممیزی اجرای خودکار.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALWAYS_APPROVAL_KINDS,
  decideApproval,
  effectiveRisk,
} from "../src/approval.js";
import { readAuditTail } from "../src/audit.js";
import { audited, result } from "../src/tools/common.js";
import { getAction } from "../src/tools/write.js";

const app = "agate-liara";

test("strict: همهٔ اقدام‌های نوشتنی تأیید می‌خواهند", () => {
  for (const risk of ["low", "medium", "high"] as const) {
    const d = decideApproval({
      tool: "liara_restart",
      params: { app },
      declaredRisk: risk,
      policy: "strict",
    });
    assert.equal(d.requiresApproval, true);
    assert.equal(d.automatic, false);
    assert.equal(d.risk, risk);
  }
});

test("balanced: low خودکار، medium تأیید، high تأیید", () => {
  const low = decideApproval({
    tool: "liara_restart",
    params: { app },
    declaredRisk: "low",
    policy: "balanced",
  });
  assert.equal(low.automatic, true);
  assert.equal(low.requiresApproval, false);
  assert.match(low.autoNoticeFa ?? "", /اجرای خودکار طبق سیاست balanced/);

  const medium = decideApproval({
    tool: "liara_set_env",
    params: { app, variables: [{ key: "NODE_ENV", value: "production" }] },
    declaredRisk: "medium",
    policy: "balanced",
  });
  assert.equal(medium.automatic, false);
  assert.equal(medium.requiresApproval, true);

  const high = decideApproval({
    tool: "liara_create_app",
    params: { name: "demo" },
    declaredRisk: "medium",
    policy: "balanced",
  });
  assert.equal(high.risk, "high");
  assert.equal(high.requiresApproval, true);
});

test("rollback_last_env_change ریسک medium دارد و در balanced تأیید می‌خواهد؛ liara_set_env هم medium است", () => {
  const rollbackParams = { app, incidentAt: "2026-10-23T12:00:00.000Z" };
  assert.equal(effectiveRisk("rollback_last_env_change", rollbackParams, "medium"), "medium");

  const rollback = decideApproval({
    tool: "rollback_last_env_change",
    params: rollbackParams,
    declaredRisk: "medium",
    policy: "balanced",
  });
  assert.equal(rollback.risk, "medium");
  assert.equal(rollback.requiresApproval, true);
  assert.equal(rollback.automatic, false);
  assert.match(rollback.reasonFa, /medium\/high/);

  const setEnv = decideApproval({
    tool: "liara_set_env",
    params: { app, variables: [{ key: "BUG_MODE", value: "off" }] },
    declaredRisk: "medium",
    policy: "balanced",
  });
  assert.equal(setEnv.risk, "medium");
  assert.equal(setEnv.requiresApproval, true);
  assert.equal(setEnv.automatic, false);
});

test("auto: low و medium خودکار، high تأیید", () => {
  const low = decideApproval({
    tool: "liara_restart",
    params: { app },
    declaredRisk: "low",
    policy: "auto",
  });
  assert.equal(low.automatic, true);

  const release = decideApproval({
    tool: "liara_deploy",
    params: { app, path: "." },
    declaredRisk: "medium",
    policy: "auto",
  });
  assert.equal(release.automatic, true);
  assert.match(release.autoNoticeFa ?? "", /اجرای خودکار طبق سیاست auto/);

  const high = decideApproval({
    tool: "liara_resize",
    params: { app, planID: "big" },
    declaredRisk: "medium",
    policy: "auto",
  });
  assert.equal(high.automatic, false);
  assert.equal(high.requiresApproval, true);
});

test("اقدام‌های هزینه‌دار/پرخطر در همهٔ سیاست‌ها high و نیازمند تأیید هستند", () => {
  for (const kind of ALWAYS_APPROVAL_KINDS) {
    for (const policy of ["strict", "balanced", "auto"] as const) {
      const d = decideApproval({
        tool: kind,
        params: { app, name: app, planID: "x", networkName: "n", on: false },
        declaredRisk: "low",
        policy,
      });
      assert.equal(d.risk, "high", `${kind}/${policy}`);
      assert.equal(d.requiresApproval, true, `${kind}/${policy}`);
    }
  }
});

test("ریسک اعلام‌شدهٔ عملیات‌های هزینه‌دار high است", () => {
  for (const kind of ["liara_create_app", "liara_create_network", "liara_resize", "liara_scale"]) {
    assert.equal(getAction(kind)?.risk, "high", kind);
  }
  assert.equal(getAction("liara_restart")?.risk, "low");
  assert.equal(getAction("rollback_last_env_change")?.risk, "medium");
  assert.equal(getAction("liara_set_env")?.risk, "medium");
});

test("سیاست ناشناخته در config به strict برمی‌گردد", async () => {
  const { config } = await import("../src/config.js");
  const previous = process.env.APPROVAL_POLICY;
  try {
    process.env.APPROVAL_POLICY = "not-a-policy";
    assert.equal(config.approvalPolicy, "strict");
  } finally {
    if (previous === undefined) delete process.env.APPROVAL_POLICY;
    else process.env.APPROVAL_POLICY = previous;
  }
});

test("اجرای خودکار با mention سیاست در ممیزی ثبت می‌شود", async () => {
  const notice = "اجرای خودکار طبق سیاست balanced — اقدام کم‌خطر و برگشت‌پذیر است.";
  await audited(
    "test_auto_policy",
    app,
    { app },
    async () => result(`🤖 ${notice}`, { ok: true, approvalMode: "automatic" }),
    "auto:balanced",
  );
  const last = readAuditTail(1)[0]!;
  assert.equal(last.tool, "test_auto_policy");
  assert.equal(last.approval, "auto:balanced");
  assert.match(last.detail ?? "", /اجرای خودکار طبق سیاست balanced/);
});

test("audited سیاست اجرای خودکار را از structuredContent هم تشخیص می‌دهد", async () => {
  await audited(
    "test_auto_policy_outer",
    app,
    { app },
    async () =>
      result("🤖 اجرای خودکار طبق سیاست balanced", {
        ok: true,
        approvalMode: "automatic",
        approvalPolicy: "balanced",
      }),
  );
  const last = readAuditTail(1)[0]!;
  assert.equal(last.tool, "test_auto_policy_outer");
  assert.equal(last.approval, "auto:balanced");
});
