import { pairLabel, type PlanPair } from "./plans.js";

/**
 * انتخاب پلن ساخت.
 * فهرست مجاز از parsePlanCatalog است (create.js:131-137).
 * promptPlan در create.js:120-161 پلن را با نوع پلتفرم عوض نمی‌کند؛
 * تنها خطای پلتفرم در create.js:69-70 است (`free_plan_platform`) و بعد از POST می‌آید.
 * کف دیسک با `volume` (create.js:143، گیگابایت) و بزرگ‌ترین size عددی liara.json سنجیده می‌شود.
 * کف رم و CPU فقط وقتی واحدشان معلوم است. جدول رمِ ساختگی برای هر پلتفرم وجود ندارد.
 */
export interface PlanNeed {
  platform: string;
  diskGB: number | null;
  memoryGB: number | null;
  cpuCores: number | null;
  similarApp?: string | null;
  usageNote?: string | null;
}

export interface PlanChoiceItem {
  role: "recommended" | "cheaper" | "stronger";
  value: string;
  labelFa: string;
  recommended?: boolean;
  pair: PlanPair;
}

export interface PlanPresentation {
  recommended: PlanPair;
  fits: boolean;
  reasonFa: string;
  cheaperFa: string;
  strongerFa: string;
  choices: PlanChoiceItem[];
}

export function diskFloorGB(disks: readonly { size?: string }[] | undefined): number | null {
  if (!disks?.length) return null;
  const sizes = disks
    .map((disk) => (disk.size && /^\d+(\.\d+)?$/.test(disk.size) ? Number(disk.size) : Number.NaN))
    .filter((size) => size > 0);
  if (!sizes.length) return null;
  return Math.max(...sizes);
}

/** ارزان‌ترین بستهٔ available هر planID. CLI اول پلن را می‌پرسد و بعد بسته را (create.js:25-26). */
export function cheapestBundlePerPlan(pairs: readonly PlanPair[]): PlanPair[] {
  const byPlan = new Map<string, PlanPair>();
  for (const pair of pairs) {
    const prev = byPlan.get(pair.planID);
    if (
      !prev ||
      pair.totalMonthly < prev.totalMonthly ||
      (pair.totalMonthly === prev.totalMonthly && pair.bundlePlanID.localeCompare(prev.bundlePlanID) < 0)
    ) {
      byPlan.set(pair.planID, pair);
    }
  }
  return [...byPlan.values()].sort(comparePairs);
}

function comparePairs(a: PlanPair, b: PlanPair): number {
  return a.totalMonthly - b.totalMonthly || a.planID.localeCompare(b.planID) || a.bundlePlanID.localeCompare(b.bundlePlanID);
}

function meets(pair: PlanPair, need: PlanNeed): boolean {
  if (need.diskGB !== null && (pair.diskGB === undefined || pair.diskGB < need.diskGB)) return false;
  if (need.memoryGB !== null && (pair.ramGB === undefined || pair.ramGB < need.memoryGB)) return false;
  if (need.cpuCores !== null && (pair.cpuCores === undefined || pair.cpuCores < need.cpuCores)) return false;
  return true;
}

function strongest(plans: readonly PlanPair[]): PlanPair {
  return [...plans].sort((a, b) => {
    const ram = (b.ramGB ?? -1) - (a.ramGB ?? -1);
    if (ram) return ram;
    const cpu = (b.cpuCores ?? -1) - (a.cpuCores ?? -1);
    if (cpu) return cpu;
    const disk = (b.diskGB ?? -1) - (a.diskGB ?? -1);
    if (disk) return disk;
    return comparePairs(b, a);
  })[0]!;
}

function reasonFor(need: PlanNeed, fits: boolean, explicit: boolean): string {
  if (explicit) {
    return `این پلن را خودتان مشخص کردید؛ برای پلتفرم ${need.platform} همین ترکیب روی کارت می‌ماند و بدون تأیید ساخته نمی‌شود.`;
  }
  const parts = [`برای پلتفرم ${need.platform}`];
  if (need.diskGB !== null) parts.push(`دیسک ${need.diskGB} گیگابایت`);
  if (need.similarApp && need.memoryGB !== null) parts.push(`رم دیده‌شدهٔ اپ «${need.similarApp}»`);
  if (need.similarApp && need.cpuCores !== null) parts.push(`CPU دیده‌شدهٔ اپ «${need.similarApp}»`);
  if (need.diskGB === null && need.memoryGB === null && need.cpuCores === null) {
    const note = need.usageNote ? ` ${need.usageNote}` : "";
    return `برای پلتفرم ${need.platform} کف دیسک و مصرف رم یا CPU در دست نیست.${note} ارزان‌ترین پلن مجاز انتخاب شد.`;
  }
  if (!fits) {
    return `${parts.join("، ")} در هیچ پلن مجازی با هم جا نمی‌شود؛ قوی‌ترین پلن مجاز به‌عنوان نزدیک‌ترین پیشنهاد آمده و بدون تأیید ساخته نمی‌شود.`;
  }
  return `${parts.join("، ")}؛ این ارزان‌ترین پلن مجازی است که همین نیاز را پوشش می‌دهد.`;
}

function choiceItem(role: PlanChoiceItem["role"], pair: PlanPair): PlanChoiceItem {
  const prefix = role === "recommended" ? "پیشنهادی" : role === "cheaper" ? "ارزان‌تر" : "قوی‌تر";
  return {
    role,
    value: `${pair.planID}/${pair.bundlePlanID}`,
    labelFa: `${prefix}: ${pairLabel(pair)}`,
    recommended: role === "recommended",
    pair,
  };
}

export function presentPlanChoice(
  pairs: readonly PlanPair[],
  need: PlanNeed,
  explicit?: { planID: string; bundlePlanID: string },
): PlanPresentation | null {
  const plans = cheapestBundlePerPlan(pairs);
  if (!plans.length) return null;
  let recommended: PlanPair;
  let fits: boolean;
  if (explicit) {
    const found = pairs.find((pair) => pair.planID === explicit.planID && pair.bundlePlanID === explicit.bundlePlanID);
    if (!found) return null;
    recommended = found;
    fits = meets(found, need);
  } else {
    const fitting = plans.filter((pair) => meets(pair, need));
    fits = fitting.length > 0;
    recommended = fits ? fitting[0]! : strongest(plans);
  }
  const others = plans.filter((pair) => pair.planID !== recommended.planID);
  const cheaper = others.filter((pair) => pair.totalMonthly < recommended.totalMonthly).sort(comparePairs).at(-1) ?? null;
  const stronger = others.filter((pair) => pair.totalMonthly > recommended.totalMonthly).sort(comparePairs)[0] ?? null;
  const choices = [choiceItem("recommended", recommended)];
  if (cheaper) choices.push(choiceItem("cheaper", cheaper));
  if (stronger) choices.push(choiceItem("stronger", stronger));
  return {
    recommended,
    fits,
    reasonFa: reasonFor(need, fits, Boolean(explicit)),
    cheaperFa: cheaper ? `گزینهٔ ارزان‌تر: ${pairLabel(cheaper)}` : "گزینهٔ ارزان‌تر: در فهرست مجاز، ارزان‌تر از این نیست.",
    strongerFa: stronger ? `گزینهٔ قوی‌تر: ${pairLabel(stronger)}` : "گزینهٔ قوی‌تر: در فهرست مجاز، قوی‌تر از این نیست.",
    choices,
  };
}

/**
 * خطای پلن را از بدنهٔ لیارا می‌خواند.
 * create.js:48-81 کد g2_plan_unavailable ندارد؛ این کد را خود API برمی‌گرداند.
 * create.js:69-73 کدهای free_plan_platform و free_plan_count را دارد.
 * create.js:55-57 پیام bundlePlan is not available را دارد.
 */
export function readPlanErrorCode(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const data = record["data"];
  const dataCode = data && typeof data === "object" ? (data as Record<string, unknown>)["code"] : undefined;
  const message = typeof record["message"] === "string" ? record["message"] : "";
  const code = typeof dataCode === "string" ? dataCode : "";
  const known = new Set(["g2_plan_unavailable", "free_plan_platform", "free_plan_count"]);
  if (known.has(code)) return code;
  if (known.has(message)) return message;
  if (message.includes("g2_plan_unavailable")) return "g2_plan_unavailable";
  if (message.includes("bundlePlan is not available")) return "bundle_plan_unavailable";
  return null;
}

export function explainPlanError(planID: string, code: string): string {
  if (code === "g2_plan_unavailable") {
    return `لیارا ساخت را با کد g2_plan_unavailable رد کرد. این خطا ممکن است از شکل درخواست باشد، نه از خود پلن «${planID}». این پلن از پیشنهاد بعدی برداشته شد و ساخت دوباره خودکار انجام نشد.`;
  }
  if (code === "free_plan_platform") {
    return `لیارا پلن رایگان را برای این پلتفرم نپذیرفت. ساخت دوباره خودکار انجام نشد.`;
  }
  if (code === "free_plan_count") {
    return `لیارا ساخت اپ دیگری روی پلن رایگان را نپذیرفت. ساخت دوباره خودکار انجام نشد.`;
  }
  if (code === "bundle_plan_unavailable") {
    return `لیارا بستهٔ امکانات این پلن را برای ساخت نپذیرفت. ساخت دوباره خودکار انجام نشد.`;
  }
  return `لیارا پلن «${planID}» را نپذیرفت (${code}). ساخت دوباره خودکار انجام نشد.`;
}

/** پلن ردشده از پیشنهاد بعدی حذف می‌شود. بقیهٔ پلن‌های فیلتر CLI می‌مانند. */
export function excludeRejectedPlan(
  pairs: readonly PlanPair[],
  planID: string,
  bundlePlanID: string,
  code: string,
): PlanPair[] {
  if (code === "bundle_plan_unavailable") {
    return pairs.filter((pair) => !(pair.planID === planID && pair.bundlePlanID === bundlePlanID));
  }
  if (code === "free_plan_platform" || code === "free_plan_count") {
    return pairs.filter((pair) => pair.planID !== "free" && pair.planID !== planID);
  }
  return pairs.filter((pair) => pair.planID !== planID);
}

export function presentReplacement(
  pairs: readonly PlanPair[],
  planID: string,
  bundlePlanID: string,
  code: string,
  need: PlanNeed,
): { explanationFa: string; presentation: PlanPresentation | null } {
  const explanationFa = explainPlanError(planID, code);
  const remaining = excludeRejectedPlan(pairs, planID, bundlePlanID, code);
  return { explanationFa, presentation: presentPlanChoice(remaining, need) };
}

export function applyChosenPlan(params: Record<string, unknown>, chosen: string | undefined): Record<string, unknown> {
  const options = Array.isArray(params["planChoices"]) ? (params["planChoices"] as PlanChoiceItem[]) : [];
  if (!options.length) return params;
  const recommended = options.find((item) => item.role === "recommended") ?? options[0];
  if (!recommended) return params;
  const picked =
    !chosen || chosen === "approve"
      ? recommended
      : options.find((item) => item.value === chosen);
  if (!picked) throw new Error("گزینهٔ پلن در کارت تأیید نیست؛ هیچ POSTی ارسال نشد.");
  return { ...params, planID: picked.pair.planID, bundlePlanID: picked.pair.bundlePlanID, quote: picked.pair };
}

export function describeCreatePlan(params: Record<string, unknown>): string {
  const quote = params["quote"] as PlanPair | undefined;
  const networkId = typeof params["network"] === "string" ? params["network"] : "";
  const networkName = typeof params["networkName"] === "string" ? params["networkName"] : "";
  const networkLine = networkId
    ? `شبکهٔ خصوصی پیشنهادی: «${networkName || "بدون نام"}» با شناسهٔ ${networkId}.`
    : "";
  const headline = `ساخت اپ «${String(params["name"] ?? "")}»: ${quote ? pairLabel(quote) : String(params["planID"] ?? "")}؛ پلتفرم ${String(params["platform"] ?? "")}.`;
  return [
    headline,
    networkLine,
    typeof params["networkReasonFa"] === "string" ? params["networkReasonFa"] : "",
    typeof params["networkOthersFa"] === "string" ? params["networkOthersFa"] : "",
    typeof params["planReasonFa"] === "string" ? params["planReasonFa"] : "",
    typeof params["planCheaperFa"] === "string" ? params["planCheaperFa"] : "",
    typeof params["planStrongerFa"] === "string" ? params["planStrongerFa"] : "",
    "ساخت فقط بعد از تأیید همین کارت انجام می‌شود.",
  ]
    .filter(Boolean)
    .join("\n");
}
