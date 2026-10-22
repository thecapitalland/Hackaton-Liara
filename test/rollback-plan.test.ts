/**
 * تست برنامهٔ rollback: فقط کلیدهای همان تغییر، با مقدار before.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { planEnvRollback } from "../src/tools/write.js";
import type { EnvChangeCandidate } from "../src/env-history.js";

const change: Pick<EnvChangeCandidate, "changes"> = {
  changes: [
    { key: "A", before: "1", after: "9" },
    { key: "B", before: "2", after: null },
    { key: "C", before: null, after: "3" },
  ],
};

test("rollback فقط کلیدهای تغییر‌یافته را برمی‌گرداند و کلیدهای دیگر را دست نمی‌زند", () => {
  const plan = planEnvRollback(
    [
      { key: "A", value: "9" },
      { key: "C", value: "3" },
      { key: "KEEP", value: "untouched" },
    ],
    change,
  );
  assert.deepEqual(plan.mismatches, []);
  assert.deepEqual(plan.vars, [
    { key: "A", value: "1" },
    { key: "B", value: "2" },
  ]);
  assert.deepEqual(plan.unset, ["C"]);
});

test("اگر env بعد از آن تغییر عوض شده باشد، rollback متوقف می‌شود", () => {
  const plan = planEnvRollback(
    [
      { key: "A", value: "8" },
      { key: "C", value: "3" },
    ],
    change,
  );
  assert.deepEqual(plan.mismatches, ["A"]);
});

test("کلید اضافه‌شده‌ای که بعداً حذف شده mismatch است", () => {
  const plan = planEnvRollback([{ key: "A", value: "9" }], change);
  assert.deepEqual(plan.mismatches, ["C"]);
});
