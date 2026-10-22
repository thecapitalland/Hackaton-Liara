import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUILD_LOCATIONS, buildReleaseBody } from '../src/tools/composite.js';
import type { StackDetection } from '../src/deploy/detect.js';

function detection(overrides: Partial<StackDetection> = {}): StackDetection {
  return {
    platform: 'node',
    port: 3000,
    app: 'agate-liara',
    requiredEnv: [],
    exampleEnv: [],
    notes: [],
    ...overrides,
  };
}

test('build.location منطقهٔ بیلد است، نه مسیر سورس', () => {
  const body = buildReleaseBody(detection(), 'src_123');
  assert.deepEqual(body.build, { cache: true, args: {}, location: 'iran' });
  assert.equal(body.sourceID, 'src_123');
  assert.equal(body.port, 3000);
  assert.equal(body.type, 'node');
  assert.ok(!('dockerfile' in (body.build as Record<string, unknown>)));
});

test('dockerfile فقط برای docker اضافه می‌شود', () => {
  const body = buildReleaseBody(detection({ platform: 'docker' }), 'src_1');
  assert.equal((body.build as Record<string, unknown>).dockerfile, 'Dockerfile');
});

test('منطقهٔ نامعتبر یا مسیر سورس پیش از POST رد می‌شود', () => {
  for (const bad of ['.', 'iran/tehran', '']) {
    assert.throws(() => buildReleaseBody(detection(), 'src_1', bad), /منطقهٔ بیلد/);
  }
  assert.deepEqual([...BUILD_LOCATIONS], ['iran', 'germany']);
  assert.equal((buildReleaseBody(detection(), 's', 'germany').build as Record<string, unknown>).location, 'germany');
});
