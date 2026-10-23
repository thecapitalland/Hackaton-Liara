/**
 * بدنه و مسیر ساخت اپ، هم‌شکل @liara/cli@9.6.0.
 * package/lib/commands/app/create.js:36-44
 *   POST v1/projects/
 *   json: name, planID, platform, bundlePlanID,
 *         network: network?._id,
 *         readOnlyRootFilesystem
 * region در این بدنه نیست.
 * network._id از base.js:211-217 (نام شبکه) یا promptNetwork در base.js:182-204 می‌آید.
 * readOnly در create.js:27-31 فقط با فلگ true/false بولین است و در غیر این صورت undefined.
 * JSON.stringify کلیدهای undefined را حذف می‌کند؛ همان چیزی است که got با json می‌فرستد.
 */
export const CREATE_APP_PATH = "/v1/projects/";

export interface CreateAppInput {
  name: string;
  planID: string;
  platform: string;
  bundlePlanID: string;
  /** شناسهٔ شبکه، همان network._id. نام شبکه اینجا فرستاده نمی‌شود. */
  networkId?: string | null;
  readOnlyRootFilesystem?: boolean;
}

export function createAppBody(input: CreateAppInput): Record<string, unknown> {
  const network = input.networkId == null || input.networkId === "" ? undefined : input.networkId;
  return {
    name: input.name,
    planID: input.planID,
    platform: input.platform,
    bundlePlanID: input.bundlePlanID,
    network,
    readOnlyRootFilesystem: input.readOnlyRootFilesystem,
  };
}
