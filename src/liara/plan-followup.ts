import { createPendingApproval, pendingMessage, type ApprovalChoice } from "../approval.js";
import { result } from "../tools/common.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describeCreatePlan, presentReplacement, readPlanErrorCode, type PlanNeed } from "./plan-choice.js";
import { fetchPlanCatalog } from "./plans.js";

/**
 * بعد از یک POST ردشده. کاتالوگ را دوباره می‌خواند و فقط کارت تازه می‌سازد.
 * liaraPost اینجا صدا زده نمی‌شود.
 */
export async function replacementForCreateResult(
  params: Record<string, unknown>,
  action: { structuredContent?: Record<string, unknown> | null; text?: string },
): Promise<CallToolResult | null> {
  const structured = action.structuredContent ?? {};
  const code =
    typeof structured["planError"] === "string"
      ? structured["planError"]
      : readPlanErrorCode(structured["providerResponse"]) ?? readPlanErrorCode({ message: action.text ?? "" });
  if (!code) return null;
  const planID = String(structured["planID"] ?? params["planID"] ?? "");
  const bundlePlanID = String(structured["bundlePlanID"] ?? params["bundlePlanID"] ?? "");
  const need = needFrom(params);
  const catalog = await fetchPlanCatalog();
  const follow = presentReplacement(catalog.pairs, planID, bundlePlanID, code, need);
  if (!follow.presentation) {
    return result(`${follow.explanationFa}\nپلن مجاز دیگری برای جایگزینی نمانده است. هیچ درخواست دومی به لیارا نرفت.`, {
      ok: false,
      code: "PLAN_REJECTED",
      planError: code,
      rejectedPlanID: planID,
    });
  }
  const app = String(params["name"] ?? params["app"] ?? "");
  const replacement = {
    name: app,
    planID: follow.presentation.recommended.planID,
    platform: need.platform,
    bundlePlanID: follow.presentation.recommended.bundlePlanID,
    ...(params["network"] ? { network: params["network"] } : {}),
    ...(params["projectPath"] ? { projectPath: params["projectPath"] } : {}),
    planReasonFa: follow.presentation.reasonFa,
    planCheaperFa: follow.presentation.cheaperFa,
    planStrongerFa: follow.presentation.strongerFa,
    planChoices: follow.presentation.choices,
    planNeed: need,
    quote: follow.presentation.recommended,
  };
  const choices: ApprovalChoice[] = [
    ...follow.presentation.choices.map((item) => ({
      value: item.value,
      labelFa: item.labelFa,
      recommended: item.recommended,
    })),
    { value: "cancel", labelFa: "لغو", descriptionFa: "بدون هیچ تغییری" },
  ];
  const record = createPendingApproval({
    tool: "liara_create_app",
    app,
    params: replacement,
    summaryFa: `${follow.explanationFa}\n${describeCreatePlan(replacement)}`,
    risk: "high",
    impact: "ساخت اپ با پلن جایگزین؛ بدون تأیید تازه هیچ POSTی ارسال نمی‌شود.",
    choices,
  });
  return result(`${follow.explanationFa}\n${pendingMessage(record)}`, {
    ok: false,
    code: "APPROVAL_REQUIRED",
    planError: code,
    rejectedPlanID: planID,
    replacementPlanID: follow.presentation.recommended.planID,
    approval: record,
  });
}

function needFrom(params: Record<string, unknown>): PlanNeed {
  const raw = params["planNeed"];
  const need = raw && typeof raw === "object" ? (raw as Partial<PlanNeed>) : {};
  return {
    platform: String(need.platform ?? params["platform"] ?? ""),
    diskGB: typeof need.diskGB === "number" ? need.diskGB : null,
    memoryGB: typeof need.memoryGB === "number" ? need.memoryGB : null,
    cpuCores: typeof need.cpuCores === "number" ? need.cpuCores : null,
    similarApp: typeof need.similarApp === "string" ? need.similarApp : null,
    usageNote: typeof need.usageNote === "string" ? need.usageNote : null,
  };
}
