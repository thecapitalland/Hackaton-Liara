/**
 * Agate-Liara — preflight فقط‌خواندنی روی API زندهٔ لیارا.
 *
 * اجرا:  npm run preflight
 * هیچ درخواست نوشتنی (POST/PUT/DELETE) ارسال نمی‌شود.
 * خروجی: کد وضعیت + شکل پاسخ (بدون توکن و بدون مقادیر حساس)
 *
 * گزارش کامل در .agate/preflight-<timestamp>.json ذخیره می‌شود.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { config, hasToken } from "../src/config.js";
import { liaraGet, LiaraError } from "../src/liara/client.js";
import { DNS_EP, EP } from "../src/liara/endpoints.js";
import { redact } from '../src/redact.js';
import { connectionDigest } from '../src/liara/preflight-gate.js';

interface Probe {
  name: string;
  path: string;
  status: number | null;
  ok: boolean;
  error?: string;
  /** شکل پاسخ: کلیدهای سطح بالا و نوع هرکدام */
  shape?: string;
  sample?: unknown;
  durationMs: number;
}

const probes: Probe[] = [];

function shapeOf(data: unknown, depth = 0): string {
  if (data === null) return "null";
  if (Array.isArray(data)) {
    if (!data.length) return "array(0)";
    if (depth > 1) return `array(${data.length})`;
    return `array(${data.length}) of ${shapeOf(data[0], depth + 1)}`;
  }
  if (typeof data !== "object") return typeof data;
  const obj = data as Record<string, unknown>;
  const parts = Object.entries(obj).map(
    ([k, v]) => `${k}: ${Array.isArray(v) ? `array(${v.length})` : v === null ? "null" : typeof v}`,
  );
  return `{ ${parts.join(", ")} }`;
}

/** نمونهٔ کوچک و بی‌خطر از پاسخ (بدون مقادیر حساس) */
function sampleOf(data: unknown): unknown {
  const seen = new WeakSet<object>();
  const clone = (value: unknown, depth = 0): unknown => {
    if (depth > 3) return "…";
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value as object)) return "…";
    seen.add(value as object);
    if (Array.isArray(value)) return value.slice(0, 2).map((v) => clone(v, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/token|secret|password|apikey|api_key/i.test(k)) {
        out[k] = "«ماسک شد»";
      } else if (typeof v === "string" && v.length > 160) {
        out[k] = `${v.slice(0, 160)}…`;
      } else {
        out[k] = clone(v, depth + 1);
      }
    }
    return out;
  };
  return clone(data);
}

async function probe(name: string, path: string, opts: { query?: Record<string, string | number>; service?: "liara" | "dns" } = {}): Promise<unknown> {
  const started = Date.now();
  try {
    const res = await liaraGet<unknown>(path, {
      query: opts.query,
      base: opts.service === "dns" ? config.dnsBase : config.apiBase,
      fallbackBase: opts.service === "dns" ? config.dnsBaseFallback : config.apiBaseFallback,
    });
    const entry: Probe = {
      name,
      path,
      status: res.status,
      ok: true,
      shape: shapeOf(res.data),
      sample: redact(sampleOf(res.data)),
      durationMs: Date.now() - started,
    };
    probes.push(entry);
    console.log(`✅ ${name.padEnd(34)} ${String(res.status).padEnd(4)} ${entry.shape ?? ""}`);
    return res.data;
  } catch (err) {
    const e = err as LiaraError;
    const entry: Probe = {
      name,
      path,
      status: e?.status ?? null,
      ok: false,
      error: e?.message ?? String(err),
      durationMs: Date.now() - started,
    };
    probes.push(entry);
    console.log(`❌ ${name.padEnd(34)} ${String(entry.status ?? "—").padEnd(4)} ${entry.error}`);
    return null;
  }
}

async function main(): Promise<void> {
  console.log("════════════════════════════════════════════════════════════");
  console.log(" Agate-Liara — preflight فقط‌خواندنی");
  console.log(` بیس API : ${config.apiBase}`);
  console.log(` بیس DNS : ${config.dnsBase}`);
  console.log(` تیم    : ${config.teamId ? "تنظیم شده (در هدر/کوئری اعمال می‌شود)" : "ندارد"}`);
  console.log("════════════════════════════════════════════════════════════");

  if (!hasToken()) {
    console.error("\n❌ LIARA_API_TOKEN تنظیم نشده است.");
    console.error("   آن را در فایل .env ریشهٔ مخزن قرار دهید و دوباره اجرا کنید.\n");
    process.exit(2);
  }

  /* ۱) فهرست پروژه‌ها */
  const projects = await probe("list projects", EP.listProjects);

  /* ۲) حساب و پلن‌ها */
  await probe("account + plans", EP.me);

  /* ۳) اپ‌های موجود (جزئیات، لاگ، رویداد، متریک، دامنه) */
  const rows: Record<string, unknown>[] = Array.isArray(projects)
    ? (projects as Record<string, unknown>[])
    : ((projects as { projects?: Record<string, unknown>[]; data?: Record<string, unknown>[] })?.projects ?? (projects as { data?: Record<string, unknown>[] })?.data ?? []);

  const appNames = rows
    .map((r) => String(r?.['project_id'] ?? r?.["name"] ?? r?.["project"] ?? ""))
    .filter(Boolean)
    .slice(0, 3);

  const allowed = config.allowedApps;
  const targets = allowed.filter(app => appNames.includes(app));

  for (const app of targets) {
    console.log(`\n── اپ: ${app} ──────────────────────────────`);
    await probe(`project detail: ${app}`, EP.getProject(app));
    await probe(`logs v2: ${app}`, EP.logsV2(app), {
      query: { start: new Date(Date.now() - 15 * 60_000).toISOString(), direction: "forward", last_lines: 20 },
    });
    await probe(`logs v1: ${app}`, EP.logsV1(app), {
      query: { since: Date.now() - 15 * 60_000 },
    });
    await probe(`events: ${app}`, EP.events(app));
    await probe(`metrics summary: ${app}`, EP.metricsSummary(app), { query: { since: 30 } });
    await probe(`metrics cpu: ${app}`, EP.metricsCpu(app), { query: { since: 30 } });
    await probe(`metrics memory: ${app}`, EP.metricsMemory(app), { query: { since: 30 } });
    await probe(`domains: ${app}`, EP.listDomains, { query: { project: app } });
    await probe(`releases: ${app}`, EP.listReleases(app));
  }

  /* ۴) دامنه‌ها */
  console.log("\n── دامنه‌ها و DNS ─────────────────────────");
  await probe("all domains", EP.listDomains);
  await probe("dns zones", DNS_EP.zones, { service: "dns" });

  /* گزارش */
  mkdirSync(config.stateDir, { recursive: true });
  const reportPath = path.join(config.stateDir, `preflight-${Date.now()}.json`);
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        ranAt: new Date().toISOString(),
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

  const failed = probes.filter((p) => !p.ok);
  const ready = probes.length >= 4 && failed.length === 0;
  writeFileSync(path.join(config.stateDir, 'preflight-gate.json'), JSON.stringify({ connection: connectionDigest(), ranAt: new Date().toISOString(), ready }), 'utf8');
  const markdown = '# Live API preflight\n\n' + new Date().toISOString() + '\n\n' + probes.map(p => `- ${p.name}: ${p.status ?? 'network error'}; ${p.shape ?? p.error}`).join('\n');
  mkdirSync('docs', { recursive: true });
  writeFileSync('docs/PREFLIGHT_LATEST.md', redact(markdown), 'utf8');
  console.log("\n════════════════════════════════════════════════════════════");
  console.log(` نتیجه: ${probes.length - failed.length}/${probes.length} بررسی موفق`);
  if (failed.length) {
    console.log(" ناموفق‌ها:");
    for (const f of failed) console.log(`   • ${f.name} — ${f.error}`);
  }
  console.log(` گزارش کامل: ${reportPath}`);
  console.log("════════════════════════════════════════════════════════════");
  if (!ready) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error("preflight با خطا متوقف شد:", err);
  process.exit(1);
});
