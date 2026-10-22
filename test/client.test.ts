import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildUrl, liaraGet, LiaraError } from '../src/liara/client.js';
import { parseSeries, cpuPercent } from '../src/diagnose/detectors.js';
import { parsePlans } from '../src/tools/read.js';

test('live keyed plans: GB RAM, uppercase CPU and total bundle pricing', () => {
  const parsed = parsePlans({plans:{projects:{'small-g2':{available:true,region:'iran',RAM:{amount:0.5},CPU:{amount:0.5},price:659.72,displayPrice:475000}},projectBundlePlans:{'small-g2':{basic:{available:true,price:381.94,displayPrice:275000},free:{available:false,price:0,displayPrice:0}}}}});
  assert.equal(parsed[0]?.ramMB,512);
  assert.equal(parsed[0]?.cpuCores,0.5);
  assert.equal(parsed[0]?.bundlePlanID,'basic');
  assert.equal(parsed[0]?.monthlyPrice,750000);
});

test('URL هر درخواست teamID دارد و تغییر میزبان رد می‌شود', () => {
  const previous = process.env.LIARA_TEAM_ID;
  process.env.LIARA_TEAM_ID = 'fixture-team';
  try {
    assert.equal(new URL(buildUrl('https://api.liara.ir','/v1/me')).searchParams.get('teamID'),'fixture-team');
    assert.throws(() => buildUrl('https://api.liara.ir','//evil.example/path'));
  } finally { if (previous === undefined) delete process.env.LIARA_TEAM_ID; else process.env.LIARA_TEAM_ID=previous; }
});

test('خطاهای auth/not-found/rate-limit بدون retry اضافی و فارسی‌اند', async () => {
  const original = globalThis.fetch;
  const token = process.env.LIARA_API_TOKEN;
  process.env.LIARA_API_TOKEN = 'fixture-only-token';
  try {
    for (const [status, code] of [[401,'AUTH_REQUIRED'],[403,'AUTH_REQUIRED'],[404,'NOT_FOUND'],[429,'API_RATE_LIMIT']] as const) {
      let calls = 0;
      globalThis.fetch = async () => { calls++; return new Response('{}',{status}); };
      await assert.rejects(liaraGet('/v1/projects'),error => error instanceof LiaraError && error.code === code && /[\u0600-\u06ff]/.test(error.message));
      assert.equal(calls,1);
    }
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(calls === 1 ? '{}' : '{"projects":[]}',{status:calls === 1 ? 503 : 200}); };
    assert.equal((await liaraGet('/v1/projects')).status,200);
    assert.equal(calls,2);
  } finally {
    globalThis.fetch = original;
    if (token === undefined) delete process.env.LIARA_API_TOKEN; else process.env.LIARA_API_TOKEN=token;
  }
});

test('Reports رسمی خوانده می‌شود اما واحد CPU حدس زده نمی‌شود', () => {
  const series = parseSeries({result:[{values:[[123,'0.2'],[124,'0.3']]}]},'cpu','%');
  assert.equal(series?.points.length,2);
  assert.equal(cpuPercent(series),null);
  assert.equal(cpuPercent({name:'cpu',unit:'%',points:[{ts:null,value:0.5}]})?.avg,0.5);
});
