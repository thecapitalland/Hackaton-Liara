import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureBuild } from '../scripts/ensure-build.js';

test('ensureBuild همیشه build را قبل از اجرا صدا می‌زند', () => {
  let calls = 0;
  ensureBuild(() => {
    calls += 1;
    return { status: 0 };
  });
  assert.equal(calls, 1, 'build باید دقیقاً یک بار و پیش از اجرای dist اجرا شود');
});

test('ensureBuild در خطای build، اجرای dist را متوقف می‌کند', () => {
  assert.throws(
    () => ensureBuild(() => ({ status: 1 })),
    /build پیش از اجرا شکست خورد/,
  );
  assert.throws(
    () => ensureBuild(() => ({ status: null, error: new Error('npm not found') })),
    /npm not found/,
  );
});
