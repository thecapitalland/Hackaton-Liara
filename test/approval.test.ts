/**
 * تست‌های موتور تأیید: هش پارامترها، مهلت، تک‌مصرف.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  canonicalJson,
  consumeApproval,
  createPendingApproval,
  getApproval,
  hashParams,
  isApprovalExpired,
  setApprovalStatus,
  validateApproval,
} from "../src/approval.js";

/** مهلت رکورد ذخیره‌شده را در فایل به گذشته می‌برد (شبیه‌سازی گذر زمان). */
function forceExpiry(approvalId: string): void {
  const file = path.join(process.cwd(), ".agate", "approvals.json");
  const store = JSON.parse(readFileSync(file, "utf8")) as {
    approvals: Record<string, { expiresAt: string }>;
  };
  store.approvals[approvalId]!.expiresAt = new Date(Date.now() - 60_000).toISOString();
  writeFileSync(file, JSON.stringify(store, null, 2), "utf8");
}

const baseReq = {
  tool: "liara_restart",
  app: "agate-liara",
  params: { app: "agate-liara" },
  summaryFa: "ری‌استارت سرویس",
  risk: "low" as const,
  impact: "قطعی کوتاه",
  choices: [{ value: "approve", labelFa: "تأیید" }],
};

test("canonicalJson پایدار است (ترتیب کلیدها مهم نیست)", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.equal(canonicalJson({ a: [1, { d: 4, c: 3 }] }), '{"a":[1,{"c":3,"d":4}]}');
});

test("hashParams به پارامترهای دقیق مقید است", () => {
  const h1 = hashParams("liara_restart", "agate-liara", { app: "agate-liara" });
  const h2 = hashParams("liara_restart", "agate-liara", { app: "other-app" });
  assert.notEqual(h1, h2);
  assert.match(h1, /^[a-f0-9]{64}$/);
});

test("تأیید معلق: معتبر، مصرف‌شدنی و تک‌مصرف", () => {
  const rec = createPendingApproval(baseReq);
  assert.equal(rec.status, "pending");
  assert.ok(validateApproval(rec).ok);

  assert.equal(consumeApproval(rec.approvalId).ok, false);
  setApprovalStatus(rec.approvalId, 'approved');
  const consumed = consumeApproval(rec.approvalId);
  assert.equal(consumed.ok, true);

  const second = consumeApproval(rec.approvalId);
  assert.equal(second.ok, false);
  assert.match(second.ok === false ? second.reason : "", /قبلاً اجرا شده/);
});

test("تأیید منقضی رد می‌شود", () => {
  const rec = createPendingApproval(baseReq);
  rec.expiresAt = new Date(Date.now() - 1000).toISOString();
  const check = validateApproval(rec);
  assert.equal(check.ok, false);
  assert.match(check.ok === false ? check.reason : "", /مهلت/);
});

test("تأیید منقضی هرگز خودکار تمدید یا approved نمی‌شود", () => {
  const rec = createPendingApproval(baseReq);
  forceExpiry(rec.approvalId);

  const stale = getApproval(rec.approvalId)!;
  assert.equal(isApprovalExpired(stale), true);

  // تلاش برای تأیید پس از پایان مهلت: باید رکورد را منقضی کند، نه تأیید.
  setApprovalStatus(rec.approvalId, "approved");
  const after = getApproval(rec.approvalId)!;
  assert.equal(after.status, "expired");

  // و مصرف/اجرای آن هم ممکن نیست.
  const consumed = consumeApproval(rec.approvalId);
  assert.equal(consumed.ok, false);
  assert.match(consumed.ok === false ? consumed.reason : "", /تازه/);
});

test("وضعیت‌های پایانی (expired/rejected/used) قابل بازگشت به approved نیستند", () => {
  const expired = createPendingApproval(baseReq);
  forceExpiry(expired.approvalId);
  setApprovalStatus(expired.approvalId, "expired");
  setApprovalStatus(expired.approvalId, "approved");
  assert.equal(getApproval(expired.approvalId)!.status, "expired");

  const rejected = createPendingApproval(baseReq);
  setApprovalStatus(rejected.approvalId, "rejected");
  setApprovalStatus(rejected.approvalId, "approved");
  assert.equal(getApproval(rejected.approvalId)!.status, "rejected");

  const used = createPendingApproval(baseReq);
  setApprovalStatus(used.approvalId, "approved");
  assert.equal(consumeApproval(used.approvalId).ok, true);
  setApprovalStatus(used.approvalId, "approved");
  assert.equal(getApproval(used.approvalId)!.status, "used");
});

test("تغییر پارامترها پس از تأیید، هش را ناهماهنگ می‌کند", () => {
  const rec = createPendingApproval(baseReq);
  const tampered = { ...rec, params: { app: "production-app" } };
  const check = validateApproval(tampered);
  assert.equal(check.ok, false);
  assert.match(check.ok === false ? check.reason : "", /یکسان نیستند/);
});
