/**
 * تست‌های موتور تأیید: هش پارامترها، مهلت، تک‌مصرف.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalJson,
  consumeApproval,
  createPendingApproval,
  hashParams,
  validateApproval,
} from "../src/approval.js";

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

test("تغییر پارامترها پس از تأیید، هش را ناهماهنگ می‌کند", () => {
  const rec = createPendingApproval(baseReq);
  const tampered = { ...rec, params: { app: "production-app" } };
  const check = validateApproval(tampered);
  assert.equal(check.ok, false);
  assert.match(check.ok === false ? check.reason : "", /یکسان نیستند/);
});
