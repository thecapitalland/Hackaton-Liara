import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlanCatalog, assertQuoteUnchanged, quoteCreate } from '../src/liara/plans.js';
import { getAction, runGuardedAction } from '../src/tools/write.js';

function fixture() {
  return {plans:{projects:{
    'small-g2':{available:true,region:'iran',displayPrice:475000,RAM:{amount:0.5},CPU:{amount:0.5}},
    'ir-small':{available:true,region:'iran',price:1319.44},
    foreign:{available:true,region:'germany',displayPrice:1},
    disabled:{available:false,region:'iran',displayPrice:0},
    implied:{region:'iran',displayPrice:0},
  },projectBundlePlans:{
    'small-g2':{basic:{available:true,displayPrice:275000},standard:{available:true,displayPrice:475000},free:{available:false,displayPrice:0}},
    g1:{default:{available:true,displayPrice:0}},
    foreign:{basic:{available:true,displayPrice:0}},
    disabled:{basic:{available:true,displayPrice:0}},
    implied:{basic:{available:true,displayPrice:0}},
  }}};
}

test('کاتالوگ: فیلتر strict و join فقط بر اساس کلید دقیق پلن', () => {
  const result = parsePlanCatalog(fixture());
  assert.deepEqual(Object.keys(result.plans.projects),['small-g2','ir-small']);
  assert.deepEqual(Object.keys(result.plans.projectBundlePlans),['small-g2']);
  assert.deepEqual(result.pairs.map(p => [p.planID,p.bundlePlanID,p.totalMonthly]),[['small-g2','basic',750000],['small-g2','standard',950000]]);
  assert.equal(result.exclusions[0]?.planID,'ir-small');
  assert.ok(!result.pairs.some(p => p.bundlePlanID === 'default' || p.bundlePlanID === 'free'));
});

test('قیمت نامعلوم یا ساختار متفاوت به حدس قیمت منجر نمی‌شود', () => {
  const raw = fixture();
  delete (raw.plans.projects['small-g2'] as any).displayPrice;
  assert.equal(parsePlanCatalog(raw).pairs.length,0);
  assert.throws(() => parsePlanCatalog({plans:{projects:[],projectBundlePlans:{}}}));
});

test('تغییر هزینه یا نبود quote قدیمی نیازمند تأیید تازه است', () => {
  const pair = parsePlanCatalog(fixture()).pairs[0]!;
  assert.doesNotThrow(() => assertQuoteUnchanged({...pair},pair));
  assert.throws(() => assertQuoteUnchanged({...pair,totalMonthly:1},pair),/تأیید تازه/);
  assert.throws(() => assertQuoteUnchanged(undefined,pair),/تأیید تازه/);
});

test('دروازهٔ ساخت و executor جفت حدسی یا هزینهٔ کهنه را پیش از POST رد می‌کنند', async () => {
  const original = globalThis.fetch;
  const token = process.env.LIARA_API_TOKEN;
  process.env.LIARA_API_TOKEN = 'fixture-not-live';
  const methods: string[] = [];
  globalThis.fetch = async (_url, init) => {
    methods.push(init?.method ?? 'GET');
    return new Response(JSON.stringify(fixture()),{status:200});
  };
  try {
    await assert.rejects(runGuardedAction('liara_create_app',{name:'agate-liara',platform:'node',planID:'ir-small',bundlePlanID:'basic'}),/هیچ POST/);
    const params = {name:'agate-liara',platform:'node',planID:'small-g2',bundlePlanID:'basic'};
    const quote = await quoteCreate(params);
    await assert.rejects(getAction('liara_create_app')!.run({...params,quote:{...quote,totalMonthly:1}}),/تأیید تازه/);
    assert.ok(methods.length >= 3);
    assert.ok(methods.every(m => m === 'GET'));
  } finally {
    globalThis.fetch = original;
    if (token === undefined) delete process.env.LIARA_API_TOKEN; else process.env.LIARA_API_TOKEN = token;
  }
});
