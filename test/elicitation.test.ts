/**
 * پاسخ elicitation نامعتبر هرگز به گزینهٔ اول سقوط نمی‌کند.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { resolveElicitationResponse } from "../src/approval.js";
import { readAuditEntries } from "../src/audit.js";
import { audited, result } from "../src/tools/common.js";
import { formatGuardedRejection } from "../src/tools/write.js";

const allowed = ["approve", "cancel"] as const;

test("accept بدون گزینه، گزینهٔ ناشناخته، cancel و decline رد می‌شوند", () => {
  const missing = resolveElicitationResponse("accept", undefined, allowed);
  assert.equal(missing.approved, false);
  assert.equal(missing.choice, undefined);
  assert.equal(missing.reason, "invalid_elicitation_response");

  const unknown = resolveElicitationResponse("accept", "promote-to-prod", allowed);
  assert.equal(unknown.approved, false);
  assert.equal(unknown.reason, "invalid_elicitation_response");

  const blank = resolveElicitationResponse("accept", "", allowed);
  assert.equal(blank.approved, false);
  assert.equal(blank.reason, "invalid_elicitation_response");

  const cancelChoice = resolveElicitationResponse("accept", "cancel", allowed);
  assert.equal(cancelChoice.approved, false);
  assert.notEqual(cancelChoice.choice, "approve");

  const cancelAction = resolveElicitationResponse("cancel", "approve", allowed);
  assert.equal(cancelAction.approved, false);

  const decline = resolveElicitationResponse("decline", "approve", allowed);
  assert.equal(decline.approved, false);

  const dismissed = resolveElicitationResponse("cancel", undefined, ["first-choice", "cancel"]);
  assert.equal(dismissed.approved, false);
  assert.notEqual(dismissed.choice, "first-choice");

  const accepted = resolveElicitationResponse("accept", "approve", allowed);
  assert.equal(accepted.approved, true);
  assert.equal(accepted.choice, "approve");
});

test("رد invalid_elicitation_response در ممیزی با همان دلیل ثبت می‌شود", async () => {
  const decision = resolveElicitationResponse("accept", undefined, allowed);
  const formatted = formatGuardedRejection("ری‌استارت سرویس", decision.reason ?? "");
  const tool = `invalid_elicitation_${randomUUID()}`;
  await audited(tool, "agate-liara", { app: "agate-liara" }, async () =>
    result(formatted.text, formatted.structured),
  );
  const rows = readAuditEntries().filter((entry) => entry.tool === tool);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.approval, "rejected");
  assert.equal(rows[0]?.result, "rejected");
  assert.match(rows[0]?.detail ?? "", /invalid_elicitation_response/);
});
