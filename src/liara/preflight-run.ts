/**
 * preflight فقط‌خواندنی. هیچ POST/PUT/DELETE نمی‌فرستد.
 * هم `npm run preflight` و هم deploy_project وقتی رسید تازه نیست این را صدا می‌زنند.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config, hasToken } from "../config.js";
import { redact } from "../redact.js";
import { liaraGet, LiaraError } from "./client.js";
import { DNS_EP, EP } from "./endpoints.js";
import { connectionDigest } from "./preflight-gate.js";
import { logsV2Query, metricsSince } from "./queries.js";

export interface PreflightProbe {
  name: string;
  path: string;
  status: number | null;
  ok: boolean;
  error?: string;
  shape?: string;
  sample?: unknown;
  durationMs: number;
}

export interface PreflightReport {
  ranAt: string;
  ready: boolean;
  probes: PreflightProbe[];
  reportPath?: string;
}

function shapeOf(data: unknown, depth = 0): string {
  if (data === null) return "null";
  if (Array.isArray(data)) {
    if (!data.length) return "array(0)";
    if (depth > 1) return `array(${data.length})`;
    return `array(${data.length}) of ${shapeOf(data[0], depth + 1)}`;
  }
  if (typeof data !== "object") return typeof data;
  const parts = Object.entries(data as Record<string, unknown>).map(
    ([key, value]) => `${key}: ${Array.isArray(value) ? `array(${value.length})` : value === null ? "null" : typeof value}`,
  );
  return `{ ${parts.join(", ")} }`;
}

function sampleOf(data: unknown): unknown {
  const seen = new WeakSet<object>();
  const clone = (value: unknown, depth = 0): unknown => {
    if (depth > 3) return "…";
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value as object)) return "…";
    seen.add(value as object);
    if (Array.isArray(value)) return value.slice(0, 2).map((item) => clone(item, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (/token|secret|password|apikey|api_key/i.test(key)) out[key] = "«ماسک شد»";
      else if (typeof child === "string" && child.length > 160) out[key] = `${child.slice(0, 160)}…`;
      else out[key] = clone(child, depth + 1);
    }
    return out;
  };
  return clone(data);
}

function writeGate(stateDir: string, ready: boolean, ranAt: string): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, "preflight-gate.json"),
    JSON.stringify({ connection: connectionDigest(), ranAt, ready }),
    "utf8",
  );
}

export async function runReadOnlyPreflight(options: {
  stateDir?: string;
  now?: () => number;
} = {}): Promise<PreflightReport> {
  const stateDir = options.stateDir ?? config.stateDir;
  const now = options.now ?? Date.now;
  const ranAt = new Date(now()).toISOString();
  const probes: PreflightProbe[] = [];

  const probe = async (
    name: string,
    probePath: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; service?: "liara" | "dns" } = {},
  ): Promise<unknown> => {
    const started = now();
    try {
      const res = await liaraGet<unknown>(probePath, {
        query: opts.query,
        base: opts.service === "dns" ? config.dnsBase : config.apiBase,
        fallbackBase: opts.service === "dns" ? config.dnsBaseFallback : config.apiBaseFallback,
      });
      probes.push({
        name,
        path: probePath,
        status: res.status,
        ok: true,
        shape: shapeOf(res.data),
        sample: redact(sampleOf(res.data)),
        durationMs: Math.max(0, now() - started),
      });
      return res.data;
    } catch (err) {
      const error = err as LiaraError;
      probes.push({
        name,
        path: probePath,
        status: error?.status ?? null,
        ok: false,
        error: error?.message ?? String(err),
        durationMs: Math.max(0, now() - started),
      });
      return null;
    }
  };

  if (!hasToken()) {
    probes.push({
      name: "token",
      path: "",
      status: null,
      ok: false,
      error: "LIARA_API_TOKEN تنظیم نشده است.",
      durationMs: 0,
    });
    writeGate(stateDir, false, ranAt);
    return { ranAt, ready: false, probes };
  }

  const projects = await probe("list projects", EP.listProjects);
  await probe("account + plans", EP.me);
  await probe("networks", EP.networks);

  const rows: Record<string, unknown>[] = Array.isArray(projects)
    ? (projects as Record<string, unknown>[])
    : ((projects as { projects?: Record<string, unknown>[]; data?: Record<string, unknown>[] })?.projects
      ?? (projects as { data?: Record<string, unknown>[] })?.data
      ?? []);
  const targets = rows
    .map((row) => ({
      name: String(row?.["project_id"] ?? row?.["name"] ?? row?.["project"] ?? ""),
      id: String(row?.["_id"] ?? ""),
    }))
    .filter((row) => row.name && config.allowedApps.includes(row.name))
    .slice(0, 3);
  const at = now();

  for (const app of targets) {
    await probe(`project detail: ${app.name}`, EP.getProject(app.name));
    if (!app.id) {
      probes.push({
        name: `disks: ${app.name}`,
        path: EP.listDisks(""),
        status: null,
        ok: false,
        error: "شناسهٔ داخلی پروژه در فهرست اپ‌ها نیست. GET دیسک با نام اپ فرستاده نشد.",
        durationMs: 0,
      });
    } else {
      await probe(`disks: ${app.name}`, EP.listDisks(app.id));
    }
    await probe(`logs v2: ${app.name}`, EP.logsV2(app.name), { query: logsV2Query(at - 15 * 60_000, true) });
    await probe(`logs v1: ${app.name}`, EP.logsV1(app.name), { query: { since: at - 15 * 60_000 } });
    await probe(`events: ${app.name}`, EP.events(app.name));
    await probe(`metrics summary: ${app.name}`, EP.metricsSummary(app.name), { query: { since: metricsSince(at) } });
    await probe(`metrics cpu: ${app.name}`, EP.metricsCpu(app.name), { query: { since: metricsSince(at) } });
    await probe(`metrics memory: ${app.name}`, EP.metricsMemory(app.name), { query: { since: metricsSince(at) } });
    await probe(`domains: ${app.name}`, EP.listDomains, { query: { project: app.name } });
    await probe(`releases: ${app.name}`, EP.listReleases(app.name));
  }

  await probe("all domains", EP.listDomains);
  await probe("dns zones", DNS_EP.zones, { service: "dns" });

  const ready = probes.length >= 4 && probes.every((item) => item.ok);
  mkdirSync(stateDir, { recursive: true });
  const reportPath = path.join(stateDir, `preflight-${now()}.json`);
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        ranAt,
        apiBase: config.apiBase,
        dnsBase: config.dnsBase,
        teamIdConfigured: Boolean(config.teamId),
        probes,
      },
      null,
      2,
    ),
    "utf8",
  );
  writeGate(stateDir, ready, ranAt);
  return { ranAt, ready, probes, reportPath };
}
