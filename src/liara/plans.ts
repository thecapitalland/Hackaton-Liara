import { z } from 'zod';
import { liaraGet } from './client.js';
import { EP } from './endpoints.js';

const record = z.record(z.string(), z.record(z.string(), z.unknown()));
const catalogSchema = z.object({ plans: z.object({
  projects: record,
  projectBundlePlans: z.record(z.string(), record),
}) });

export interface PlanPair {
  planID: string;
  bundlePlanID: string;
  resourceMonthly: number;
  bundleMonthly: number;
  totalMonthly: number;
  ramGB?: number;
  cpuCores?: number;
}

function monthly(item: Record<string, unknown>): number | null {
  if (typeof item.displayPrice === 'number' && Number.isFinite(item.displayPrice) && item.displayPrice >= 0) return item.displayPrice;
  if (typeof item.price === 'number' && Number.isFinite(item.price) && item.price >= 0) return item.price * 720;
  return null;
}

/** Exact-key join only. No g1 fallback, hardcoded generation, bundle name, or availability inference. */
export function parsePlanCatalog(raw: unknown) {
  const { plans } = catalogSchema.parse(raw);
  const projects = Object.fromEntries(Object.entries(plans.projects).filter(([,p]) => p.available === true && p.region === 'iran'));
  const projectBundlePlans = Object.fromEntries(Object.keys(projects).filter(id => plans.projectBundlePlans[id]).map(id => [id,
    Object.fromEntries(Object.entries(plans.projectBundlePlans[id]!).filter(([,b]) => b.available === true)),
  ]));
  const pairs: PlanPair[] = [];
  const exclusions: { planID: string; reason: string }[] = [];
  for (const [planID,p] of Object.entries(projects)) {
    const bundles = projectBundlePlans[planID];
    const resourceMonthly = monthly(p);
    if (!bundles || !Object.keys(bundles).length) {
      exclusions.push({planID,reason:'هیچ بستهٔ available=true زیر کلید دقیق همین planID نیست.'});
      continue;
    }
    for (const [bundlePlanID,b] of Object.entries(bundles)) {
      const bundleMonthly = monthly(b);
      if (resourceMonthly === null || bundleMonthly === null) { exclusions.push({planID,reason:`قیمت معتبر برای ${bundlePlanID} در API موجود نیست.`}); continue; }
      const RAM = p.RAM as {amount?: number} | undefined;
      const CPU = p.CPU as {amount?: number} | undefined;
      pairs.push({planID,bundlePlanID,resourceMonthly,bundleMonthly,totalMonthly:resourceMonthly+bundleMonthly,ramGB:RAM?.amount,cpuCores:CPU?.amount});
    }
  }
  pairs.sort((a,b) => a.totalMonthly-b.totalMonthly || a.planID.localeCompare(b.planID) || a.bundlePlanID.localeCompare(b.bundlePlanID));
  return { plans: {projects,projectBundlePlans}, pairs, exclusions };
}

export async function fetchPlanCatalog() {
  const {data} = await liaraGet(EP.me);
  return parsePlanCatalog(data);
}

export async function quoteCreate(params: Record<string, unknown>): Promise<PlanPair> {
  const catalog = await fetchPlanCatalog();
  const pair = catalog.pairs.find(p => p.planID === params.planID && p.bundlePlanID === params.bundlePlanID);
  if (!pair) throw new Error('❌ ترکیب پلن/بسته در فهرست زندهٔ همین تیم موجود، فعال، ایرانی و قیمت‌دار نیست؛ هیچ POSTی ارسال نشد.');
  return pair;
}

export function assertQuoteUnchanged(approved: unknown, fresh: PlanPair): void {
  const old = approved as PlanPair | undefined;
  if (!old || ['planID','bundlePlanID','resourceMonthly','bundleMonthly','totalMonthly'].some(k => old[k as keyof PlanPair] !== fresh[k as keyof PlanPair])) {
    throw new Error('❌ پلن یا هزینه نسبت به پیشنهاد تأییدشده تغییر کرده؛ پیشنهاد و تأیید تازه لازم است. هیچ POSTی ارسال نشد.');
  }
}

export function pairLabel(p: PlanPair): string {
  return `${p.planID}/${p.bundlePlanID} — ${p.totalMonthly.toLocaleString('fa-IR')} تومان/ماه (منابع ${p.resourceMonthly.toLocaleString('fa-IR')} + بسته ${p.bundleMonthly.toLocaleString('fa-IR')})`;
}
