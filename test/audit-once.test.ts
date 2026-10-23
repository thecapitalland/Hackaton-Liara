/**
 * هر فراخوانی ابزار فقط یک خط ممیزی دارد، حتی اگر audited تودرتو باشد.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setElicitor } from "../src/approval.js";
import { readAuditEntries } from "../src/audit.js";
import { connectionDigest } from "../src/liara/preflight-gate.js";
import { audited, result } from "../src/tools/common.js";
import { runGuardedAction } from "../src/tools/write.js";

test("audited تودرتو یک خط می‌نویسد", async () => {
  const tool = `audit_once_${randomUUID()}`;
  await audited(tool, "agate-liara", { app: "agate-liara" }, async () =>
    audited(tool, "agate-liara", { app: "agate-liara" }, async () => result("یک‌بار", { ok: true })),
  );
  const rows = readAuditEntries().filter((entry) => entry.tool === tool);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.result, "ok");
  assert.match(rows[0]?.detail ?? "", /یک‌بار/);
});

test("تأیید انسانیِ موفق روی پوشهٔ بیرونی approved ثبت می‌شود", async () => {
  const state = mkdtempSync(path.join(tmpdir(), "agate-audit-once-"));
  const previousState = process.env["AGATE_STATE_DIR"];
  process.env["AGATE_STATE_DIR"] = state;
  writeFileSync(
    path.join(state, "preflight-gate.json"),
    JSON.stringify({ connection: connectionDigest(), ready: true, ranAt: new Date().toISOString() }),
  );
  const original = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = async () => {
    posts += 1;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  setElicitor(async () => ({ approved: true, choice: "approve" }));
  const tool = `approved_audit_${randomUUID()}`;
  try {
    await audited(tool, "agate-liara", { app: "agate-liara" }, async () => {
      const out = await runGuardedAction("liara_restart", { app: "agate-liara" });
      return out.res;
    });
    const rows = readAuditEntries().filter((entry) => entry.tool === tool);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.approval, "approved");
    assert.equal(rows[0]?.result, "ok");
    assert.equal(posts, 1);
  } finally {
    globalThis.fetch = original;
    setElicitor(null);
    if (previousState === undefined) delete process.env["AGATE_STATE_DIR"];
    else process.env["AGATE_STATE_DIR"] = previousState;
    rmSync(state, { recursive: true, force: true });
  }
});
