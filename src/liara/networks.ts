import { liaraGet } from "./client.js";
import { EP } from "./endpoints.js";

/**
 * فهرست شبکهٔ خصوصی، هم‌شکل @liara/cli@9.6.0.
 * package/lib/base.js:186 promptNetwork: GET v1/networks → {networks:[]}
 * package/lib/types/network.d.ts: هر شبکه `_id` و `name` دارد.
 * package/lib/base.js:188-190 اگر فهرست خالی باشد CLI قبل از POST خارج می‌شود.
 * package/lib/commands/app/create.js:22-24 و :42 قبل از POST نام را به `network._id` تبدیل می‌کند.
 * package/lib/commands/app/shell.js:18-20 فیلد `project.network` را روی ردیف فهرست پروژه‌ها می‌خواند
 * و فقط بود و نبودش را چک می‌کند. مقدار رشته به‌عنوان `_id` خوانده می‌شود،
 * چون create.js:42 همان شناسه را می‌فرستد. شیء هم فقط با `_id` و `name` خوانده می‌شود.
 */
export interface ListedNetwork {
  id: string;
  name: string;
}

export interface NetworkSuggestion {
  recommended: ListedNetwork | null;
  reasonFa: string;
}

interface ProjectNetwork {
  app: string;
  networkId: string | null;
  networkName: string | null;
}

export function parseNetworkList(data: unknown): ListedNetwork[] | null {
  if (!data || typeof data !== "object") return null;
  const rows = (data as Record<string, unknown>)["networks"];
  if (!Array.isArray(rows)) return null;
  const networks: ListedNetwork[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") return null;
    const record = row as Record<string, unknown>;
    const id = record["_id"];
    const name = record["name"];
    if (typeof id !== "string" || id.length === 0 || typeof name !== "string" || name.length === 0) return null;
    networks.push({ id, name });
  }
  return networks;
}

export function suggestNetwork(
  networks: readonly ListedNetwork[],
  projects: unknown,
  preferApp = "agate-liara",
): NetworkSuggestion {
  const attached = projectNetworks(projects);
  const preferred = attached.find((row) => row.app === preferApp);
  const preferredNetwork = preferred ? matchNetwork(networks, preferred) : undefined;
  if (preferred && preferredNetwork) {
    return {
      recommended: preferredNetwork,
      reasonFa: `اپ «${preferred.app}» روی شبکهٔ «${preferredNetwork.name}» است.`,
    };
  }
  for (const row of attached) {
    const found = matchNetwork(networks, row);
    if (found) {
      return { recommended: found, reasonFa: `اپ «${row.app}» روی شبکهٔ «${found.name}» است.` };
    }
  }
  if (networks.length === 1) {
    const only = networks[0]!;
    return { recommended: only, reasonFa: "در فهرست فقط همین شبکهٔ خصوصی هست." };
  }
  const named = networks.find((network) => network.name === preferApp);
  if (named) {
    return {
      recommended: named,
      reasonFa: `شبکه‌ای با نام «${preferApp}» در فهرست هست. اتصال اپ از فیلد network پروژه خوانده نشد.`,
    };
  }
  return { recommended: null, reasonFa: "چند شبکه هست و شبکهٔ هیچ اپی از فهرست پروژه‌ها مشخص نشد." };
}

export type DeployNetwork =
  | { kind: "ready"; network: ListedNetwork; reasonFa: string; others: ListedNetwork[] }
  | { kind: "empty" }
  | { kind: "choose"; networks: ListedNetwork[] }
  | { kind: "missing"; given: string }
  | { kind: "unreadable" };

/** اگر شناسه داده نشده باشد، شبکه را از فهرست می‌خواند و بدون شناسه ready برنمی‌گردد. */
export async function resolveDeployNetwork(explicit: string | undefined, preferApp = "agate-liara"): Promise<DeployNetwork> {
  let listed: ListedNetwork[] | null;
  try {
    const response = await liaraGet<unknown>(EP.networks);
    listed = parseNetworkList(response.data);
  } catch {
    return { kind: "unreadable" };
  }
  if (!listed) return { kind: "unreadable" };

  const given = explicit?.trim() ?? "";
  if (given) {
    const found = listed.find((network) => network.id === given) ?? listed.find((network) => network.name === given);
    if (!found) return { kind: "missing", given };
    const via = found.id === given ? "شناسه" : "نام";
    return {
      kind: "ready",
      network: found,
      reasonFa: `شبکه با ${via} داده‌شده در فهرست پیدا شد.`,
      others: listed.filter((network) => network.id !== found.id),
    };
  }
  if (!listed.length) return { kind: "empty" };

  let projects: unknown = null;
  try {
    projects = (await liaraGet<unknown>(EP.listProjects)).data;
  } catch {
    projects = null;
  }
  const suggestion = suggestNetwork(listed, projects, preferApp);
  if (!suggestion.recommended) return { kind: "choose", networks: listed };
  return {
    kind: "ready",
    network: suggestion.recommended,
    reasonFa: suggestion.reasonFa,
    others: listed.filter((network) => network.id !== suggestion.recommended!.id),
  };
}

function projectNetworks(data: unknown): ProjectNetwork[] {
  if (!data || typeof data !== "object") return [];
  const rows = (data as Record<string, unknown>)["projects"];
  if (!Array.isArray(rows)) return [];
  const projects: ProjectNetwork[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const app = record["project_id"] ?? record["name"];
    if (typeof app !== "string" || app.length === 0) continue;
    const network = record["network"];
    if (typeof network === "string" && network.length > 0) {
      projects.push({ app, networkId: network, networkName: null });
      continue;
    }
    if (network && typeof network === "object") {
      const item = network as Record<string, unknown>;
      const networkId = typeof item["_id"] === "string" && item["_id"].length > 0 ? item["_id"] : null;
      const networkName = typeof item["name"] === "string" && item["name"].length > 0 ? item["name"] : null;
      if (networkId || networkName) projects.push({ app, networkId, networkName });
    }
  }
  return projects;
}

function matchNetwork(networks: readonly ListedNetwork[], project: ProjectNetwork): ListedNetwork | undefined {
  if (project.networkId) {
    const byId = networks.find((network) => network.id === project.networkId);
    if (byId) return byId;
  }
  if (project.networkName) {
    return networks.find((network) => network.name === project.networkName);
  }
  return undefined;
}
