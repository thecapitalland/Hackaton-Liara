import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/index.js';
import { PACKAGE_ROOT } from '../src/config.js';
import { setElicitor } from '../src/approval.js';
import { runGuardedAction } from '../src/tools/write.js';
import { liaraPost } from '../src/liara/client.js';
import { redact } from '../src/redact.js';
import { parsePlans } from '../src/tools/read.js';
import { httpProbe, isSafeTarget } from '../src/probe.js';

test('لغو ری‌استارت و دیپلوی: صفر درخواست شبکه', async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('unexpected request'); };
  setElicitor(async () => ({approved:false}));
  try {
    for (const kind of ['liara_restart','liara_deploy']) {
      const res = await runGuardedAction(kind,{app:'agate-liara',path:'.'});
      assert.equal(res.executed,false);
      assert.equal(res.res.structuredContent?.code,'REJECTED');
    }
    assert.equal(requests,0);
  } finally { globalThis.fetch = original; setElicitor(null); }
});

test('نوشتن بدون preflight پیش از fetch متوقف می‌شود', async () => {
  const previous = process.env.LIARA_API_TOKEN;
  process.env.LIARA_API_TOKEN = 'test-only-token-not-live';
  try { await assert.rejects(liaraPost('/v1/projects',{}),/preflight/); }
  finally { if (previous === undefined) delete process.env.LIARA_API_TOKEN; else process.env.LIARA_API_TOKEN=previous; }
});

test('مقادیر محیطی و کلیدها از پاسخ حذف می‌شوند', () => {
  const safe = redact({project:{envs:[{key:'ADMIN_KEY',value:'test-only-secret'}]},variables:[{key:'OTHER',value:'test-only-secret'}]});
  assert.ok(!JSON.stringify(safe).includes('test-only-secret'));
});

test('پلن‌ها از plans.projects خوانده می‌شوند و ناموجود حذف می‌شود', () => {
  const plans = parsePlans({plans:{projects:[{planID:'small',memory:256,available:true},{planID:'gone',available:false}]}});
  assert.equal(plans.length,1);
  assert.equal(plans[0]?.planID,'small');
});

test('مقصد و مسیر ناامن پروب رد می‌شود', async () => {
  assert.equal(isSafeTarget('http://127.0.0.1'),false);
  assert.equal(isSafeTarget('https://agate-liara.liara.run:8443'),false);
  assert.ok('error' in await httpProbe('agate-liara',{path:'//127.0.0.1'}));
});

test('deploy_project روی اپ موجود هم تأیید جداگانه می‌گیرد', async () => {
  const token = process.env.LIARA_API_TOKEN;
  const state = process.env.AGATE_STATE_DIR;
  process.env.LIARA_API_TOKEN = 'test-only-token-not-live';
  process.env.AGATE_STATE_DIR = path.join(tmpdir(), `agate-safety-${Date.now()}`);
  const original = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = async (_url, init) => { methods.push(init?.method ?? 'GET'); return new Response(JSON.stringify({project:{envs:[]}}),{status:200}); };
  const server = createServer();
  const client = new Client({name:'safety',version:'1.0.0'});
  const [ct,st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st),client.connect(ct)]);
    const res = await client.callTool({name:'deploy_project',arguments:{projectPath:PACKAGE_ROOT,app:'agate-liara'}});
    assert.equal((res.structuredContent as any)?.code,'APPROVAL_REQUIRED');
    assert.ok(methods.every(m => m === 'GET'));
  } finally {
    globalThis.fetch = original;
    if (token === undefined) delete process.env.LIARA_API_TOKEN; else process.env.LIARA_API_TOKEN=token;
    if (state === undefined) delete process.env.AGATE_STATE_DIR; else process.env.AGATE_STATE_DIR=state;
    await client.close(); await server.close();
  }
});
