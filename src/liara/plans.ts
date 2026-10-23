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
  /** Disk GB. @liara/cli@9.6.0 package/lib/commands/app/create.js:143 (`volume`). */
  diskGB?: number;
}

/**
 * پلن قابل‌ساخت اپ جدید.
 * @liara/cli@9.6.0 package/lib/commands/app/create.js:131-137
 * @liara/cli@9.6.0 package/lib/commands/plan/list.js:11-13
 * فیلدها: شناسه `free` یا شامل `g2`، `available === true`، `region === 'iran'`.
 * نسل جداگانه‌ای در این سورس نیست و از اسم خطا ساخته نمی‌شود.
 */
export function isCreatableProjectPlan(planID: string, plan: Record<string, unknown>): boolean {
  return (planID === "free" || planID.includes("g2")) && plan.available === true && plan.region === "iran";
}

function monthly(item: Record<string, unknown>): number | null {
  if (typeof item.displayPrice === 'number' && Number.isFinite(item.displayPrice) && item.displayPrice >= 0) return item.displayPrice;
  if (typeof item.price === 'number' && Number.isFinite(item.price) && item.price >= 0) return item.price * 720;
  return null;
}

/**
 * Join فقط با کلید دقیق planID.
 * بسته: create.js:100-102، `projectBundlePlans[planID]` و `available`.
 * قیمت منابع: create.js:144 از `price * 720`؛ اگر API عدد `displayPrice` داده همان ماهانه است.
 * قیمت بسته: create.js:103-105 فیلد `displayPrice`.
 */
export function parsePlanCatalog(raw: unknown) {
  const { plans } = catalogSchema.parse(raw);
  const exclusions: { planID: string; reason: string }[] = [];
  const projects: Record<string, Record<string, unknown>> = {};
  for (const [planID, plan] of Object.entries(plans.projects)) {
    if (!isCreatableProjectPlan(planID, plan)) {
      exclusions.push({
        planID,
        reason: "فیلتر ساخت CLI نیست: شناسه باید free یا شامل g2 باشد و available و region=iran (@liara/cli@9.6.0 create.js:131-137).",
      });
      continue;
    }
    projects[planID] = plan;
  }
  const projectBundlePlans = Object.fromEntries(Object.keys(projects).filter(id => plans.projectBundlePlans[id]).map(id => [id,
    Object.fromEntries(Object.entries(plans.projectBundlePlans[id]!).filter(([,b]) => b.available === true)),
  ]));
  const pairs: PlanPair[] = [];
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
      const diskGB = typeof p.volume === "number" && Number.isFinite(p.volume) && p.volume > 0 ? p.volume : undefined;
      pairs.push({planID,bundlePlanID,resourceMonthly,bundleMonthly,totalMonthly:resourceMonthly+bundleMonthly,ramGB:RAM?.amount,cpuCores:CPU?.amount,diskGB});
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

export interface DiskQuote {
  name: string;
  size: string;
  monthly: number | null;
  note: string;
}

const DISK_PRICE_KEYS = new Set(["diskPrice", "pricePerGB", "diskMonthly", "disk_price"]);

/** فقط کلیدهای صریح قیمت دیسک. اگر نباشند null برمی‌گردد و عددی ساخته نمی‌شود. */
export function findDiskMonthly(raw: unknown): number | null {
  const stack: unknown[] = [raw];
  const seen = new Set<unknown>();
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    for (const [key, value] of Object.entries(current as Record<string, unknown>)) {
      if (DISK_PRICE_KEYS.has(key) && typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
      if (value && typeof value === "object") stack.push(value);
    }
  }
  return null;
}

export async function quoteDisk(params: Record<string, unknown>): Promise<DiskQuote> {
  const name = String(params["name"] ?? "");
  const size = String(params["size"] ?? "");
  let monthly: number | null = null;
  try {
    const { data } = await liaraGet(EP.me);
    monthly = findDiskMonthly(data);
  } catch {
    monthly = null;
  }
  return {
    name,
    size,
    monthly,
    note:
      monthly === null
        ? "در GET /v1/me کلید قیمت دیسک (diskPrice یا pricePerGB یا diskMonthly) پیدا نشد؛ عددی حدس زده نشد."
        : "عدد قیمت از کلید صریح دیسک در GET /v1/me خوانده شد؛ واحد را همان API تعیین می‌کند.",
  };
}

export function assertDiskQuoteUnchanged(approved: unknown, fresh: DiskQuote): void {
  const old = approved as DiskQuote | undefined;
  if (!old || old.name !== fresh.name || old.size !== fresh.size || old.monthly !== fresh.monthly) {
    throw new Error("اندازه یا قیمت دیسک نسبت به پیشنهاد تأییدشده تغییر کرده؛ هیچ POSTی ارسال نشد.");
  }
}

export function pairLabel(p: PlanPair): string {
  return `${p.planID}/${p.bundlePlanID} — ${p.totalMonthly.toLocaleString('fa-IR')} تومان/ماه (منابع ${p.resourceMonthly.toLocaleString('fa-IR')} + بسته ${p.bundleMonthly.toLocaleString('fa-IR')})`;
}
