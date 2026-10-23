import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rememberSummary } from "../src/diagnose/summary-history.js";
import { assessSummaryMemory, samplesFromSummary } from "../src/diagnose/summary-memory.js";

test("نمونه‌های memoryUsage خوانده می‌شوند و روند صعودی مشخص می‌شود", () => {
  const raw = {
    memoryUsage: [{ applet: "web", value: [[1, "20"], [2, "40"], [3, 70]] }],
  };
  assert.deepEqual(samplesFromSummary(raw), [20, 40, 70]);
  const assessed = assessSummaryMemory(raw, 512);
  assert.equal(assessed.rising, true);
  assert.equal(assessed.over80, false);
  assert.equal(assessed.unit, "MB");
  assert.match(assessed.line, /summary-memory samples=3 rising=true over80=false/);
});

test("دو خواندن پشت‌سرهم summary اگر بالا برود rising است", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agate-summary-"));
  try {
    const first = rememberSummary("demo", { memoryUsage: [{ value: [1, "100"] }] }, 512, dir);
    assert.equal(first.rising, false);
    const second = rememberSummary("demo", { memoryUsage: [{ value: [2, "180"] }] }, 512, dir);
    assert.equal(second.rising, true);
    assert.match(second.line, /samples=2 rising=true/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("عبور از ۸۰٪ سقف پلن over80 است و مقدار بایتی به مگابایت سنجیده می‌شود", () => {
  const high = assessSummaryMemory({ memoryUsage: [{ value: [[1, 100], [2, 450]] }] }, 512);
  assert.equal(high.over80, true);
  assert.equal(high.unit, "MB");
  const flat = assessSummaryMemory({ memoryUsage: [{ value: [[1, 450], [2, 450]] }] }, 512);
  assert.equal(flat.rising, false);
  assert.equal(flat.over80, true);
  const dipped = assessSummaryMemory({ memoryUsage: [{ value: [[1, 200], [2, 50], [3, 80]] }] }, 512);
  assert.equal(dipped.rising, true);
  const bytes = assessSummaryMemory({ memoryUsage: [{ value: [[1, 20_000_000], [2, 40_000_000]] }] }, 512);
  assert.equal(bytes.unit, "bytes");
  assert.equal(bytes.over80, false);
  assert.equal(bytes.rising, true);
  const over = assessSummaryMemory({ memoryUsage: [{ value: [[1, 400_000_000], [2, 471_859_200]] }] }, 512);
  assert.equal(over.unit, "bytes");
  assert.equal(over.over80, true);
});
