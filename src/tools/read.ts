/**
 * Agate-Liara — ابزارهای Tier A (فقط‌خواندنی).
 *
 * همهٔ این ابزارها بدون تأیید کاربر اجرا می‌شوند و در لاگ ممیزی ثبت می‌گردند.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config, hasToken } from "../config.js";
import { fa } from "../i18n/fa.js";
import { liaraGet, liaraRequest } from "../liara/client.js";
import { EP } from "../liara/endpoints.js";
import { parseEvents, parseLogs, parseSeries, slope } from "../diagnose/detectors.js";
import { httpProbe, probeSummary } from "../probe.js";
import { readAuditTail } from "../audit.js";
import { audited, bullets, faTime, result } from "./common.js";
import type { EventItem, LogLine, PlanLimits, Series } from "../types.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

/** استخراج آرایه از پاسخ‌های مختلف لیارا */
function rowsOf(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const key of ["data", "projects", "items", "results", "domains", "releases", "events", "logs", "list"]) {
      const v = obj[key];
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}

function str(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length) return v;
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

function num(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = Number.parseFloat(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

/** نرمال‌سازی فهرست پلن‌ها از GET /v1/me */
export function parsePlans(data: unknown): PlanLimits[] {
  const envelope = data as { plans?: { projects?: unknown[] } } | null;
  const plans = envelope?.plans?.projects ?? rowsOf(data);
  const out: PlanLimits[] = [];
  for (const p of plans) {
    if (!p || typeof p !== "object") continue;
    const obj = p as Record<string, unknown>;
    if (obj['available'] === false) continue;
    const planID = str(obj, ["planID", "id", "planId", "_id"]);
    if (!planID) continue;
    const price =
      str(obj, ["price", "priceLabel", "priceText", "displayPrice"]) ??
      (typeof obj["price"] === "number" ? String(obj["price"]) : undefined);
    out.push({
      planID,
      name: str(obj, ["name", "title", "label", "displayName"]),
      ramMB:
        num(obj, ["memory", "ram", "ramMB", "memoryMB", "limitMemory", "memoryLimit"]) ??
        (typeof obj["memory"] === "object"
          ? num((obj["memory"] as Record<string, unknown>), ["amount", "value", "mb"])
          : undefined),
      cpuCores:
        num(obj, ["cpu", "cpus", "cpuCores", "limitCPU", "cpuLimit"]) ??
        (typeof obj["cpu"] === "object"
          ? num((obj["cpu"] as Record<string, unknown>), ["amount", "value", "cores"])
          : undefined),
      price,
      region: str(obj, ["region", "regionID", "location"]),
    });
  }
  return out;
}

/** ثبت ابزارهای خواندنی روی سرور */
export function registerReadTools(server: McpServer): void {
  /* ── ping ─────────────────────────────────────────────────────────── */
  server.registerTool(
    "ping",
    {
      title: "بررسی سلامت سرور Agate-Liara",
      description:
        "بررسی سلامت خود سرویس MCP آگیت-لیارا و وضعیت تنظیم توکن لیارا. هیچ درخواستی به لیارا زده نمی‌شود.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () =>
      audited("ping", undefined, {}, async () =>
        result(
          [
            "✅ سرور Agate-Liara فعال است.",
            `🔑 توکن لیارا: ${hasToken() ? "تنظیم شده" : "تنظیم نشده"}`,
            `📦 اپ‌های مجاز: ${config.allowedApps.join("، ")}`,
            `🤖 LLM: ${config.llmEnabled ? `فعال (${config.llmModel})` : "غیرفعال — حالت قواعد"}`,
            `🌐 بیس API: ${config.apiBase}`,
          ].join("\n"),
          { ok: true, token: hasToken(), allowedApps: config.allowedApps, llm: config.llmEnabled },
        ),
      ),
  );

  /* ── liara_list_apps ─────────────────────────────────────────────── */
  server.registerTool(
    "liara_list_apps",
    {
      title: "فهرست اپ‌های لیارا",
      description: "فهرست همهٔ اپ‌های موجود در حساب لیارا (فقط‌خواندنی).",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () =>
      audited("liara_list_apps", undefined, {}, async () => {
        const { data } = await liaraGet<unknown>(EP.listProjects);
        const rows = rowsOf(data);
        if (!rows.length) return result(`${fa.appsHeader}\n${fa.noApps}`, { ok: true, apps: [] });
        const lines = rows.map((r) => {
          const obj = (r ?? {}) as Record<string, unknown>;
          const name = str(obj, ["project_id", "name", "project", "app", "projectID"]) ?? "—";
          const status = str(obj, ["status", "state", "phase"]) ?? "—";
          const plan = str(obj, ["plan", "planID", "planId"]) ?? "—";
          const created = str(obj, ["created_at", "createdAt", "date"]);
          return `• ${name} — وضعیت: ${status} | پلن: ${plan}${created ? ` | ساخت: ${faTime(created)}` : ""}`;
        });
        return result(`${fa.appsHeader}\n${bullets(lines)}`, { ok: true, apps: rows });
      }),
  );

  /* ── liara_status ────────────────────────────────────────────────── */
  server.registerTool(
    "liara_status",
    {
      title: "وضعیت اپ لیارا",
      description:
        "وضعیت کامل یک اپ لیارا: وضعیت سرویس، پلن، مقیاس، تعداد متغیرهای محیطی و دامنه‌های متصل (فقط‌خواندنی).",
      inputSchema: {
        app: z.string().min(1).describe("نام اپ در لیارا"),
      },
      annotations: READ_ONLY,
    },
    async ({ app }) =>
      audited("liara_status", app, { app }, async () => {
        const { data } = await liaraGet<Record<string, unknown>>(
          EP.getProject(app),
        );
        const obj = (data?.project ?? data ?? {}) as Record<string, unknown>;
        const status = str(obj, ["status", "state", "phase"]) ?? "—";
        const plan = str(obj, ["plan", "planID", "planId"]) ?? "—";
        const scale = str(obj, ["scale", "replicas", "instances"]) ?? "—";
        const envs = obj["envs"];
        const envKeys = Array.isArray(envs)
          ? envs.map((e) =>
              e && typeof e === "object" ? String((e as Record<string, unknown>)["key"] ?? "") : String(e),
            )
          : [];
        const lastRelease = str(obj, ["lastRelease", "release", "latestRelease"]);

        let domainLines: string[] = [];
        try {
          const d = await liaraGet<unknown>(EP.listDomains, { query: { project: app } });
          const domains = rowsOf(d.data).map((r) => {
            const o = (r ?? {}) as Record<string, unknown>;
            return `• ${str(o, ["name", "domain"]) ?? "—"} — ${str(o, ["type", "status"]) ?? ""}`;
          });
          domainLines = domains.length ? domains : ["—"];
        } catch {
          domainLines = ["(دریافت دامنه‌ها ناموفق بود)"];
        }

        const lines = [
          `${fa.statusHeader(app)}`,
          `• وضعیت سرویس: ${status}`,
          `• پلن: ${plan}`,
          `• مقیاس: ${scale}`,
          `• متغیرهای محیطی: ${envKeys.length} کلید${envKeys.length ? ` (${envKeys.join("، ")})` : ""}`,
          lastRelease ? `• آخرین انتشار: ${lastRelease}` : "",
          `🌐 دامنه‌ها:`,
          ...domainLines.map((l) => `  ${l}`),
        ].filter(Boolean);

        return result(lines.join("\n"), { ok: true, app, project: obj, envKeys });
      }),
  );

  /* ── liara_logs ──────────────────────────────────────────────────── */
  server.registerTool(
    "liara_logs",
    {
      title: "لاگ‌های زمان اجرای اپ",
      description:
        "خواندن لاگ‌های زمان اجرای اپ لیارا (ابتدا API نسخهٔ ۲ و در صورت خطا نسخهٔ ۱). فقط‌خواندنی.",
      inputSchema: {
        app: z.string().min(1).describe("نام اپ در لیارا"),
        sinceMinutes: z.number().int().min(1).max(1440).default(15).describe("بازهٔ زمانی به دقیقه"),
        lines: z.number().int().min(10).max(2000).default(200).describe("حداکثر تعداد خط"),
        level: z
          .enum(["all", "error", "warn", "info", "debug"])
          .default("all")
          .describe("فیلتر سطح لاگ"),
      },
      annotations: READ_ONLY,
    },
    async ({ app, sinceMinutes, lines, level }) =>
      audited("liara_logs", app, { app, sinceMinutes, lines, level }, async () => {
        const since = new Date(Date.now() - sinceMinutes * 60_000).toISOString();
        let raw: unknown;
        let source = "v2";
        try {
          const res = await liaraGet<unknown>(EP.logsV2(app), {
            query: { start: since, direction: "forward", last_lines: lines },
          });
          raw = res.data;
        } catch {
          source = "v1";
          const res = await liaraGet<unknown>(EP.logsV1(app), {
            query: { since: new Date(Date.now() - sinceMinutes * 60_000).getTime() },
          });
          raw = res.data;
        }

        let parsed: LogLine[] = parseLogs(raw);
        if (level !== "all") parsed = parsed.filter((l) => l.level === level);
        const sliced = parsed.slice(-lines);

        if (!sliced.length) {
          return result(`${fa.logsHeader(app, sinceMinutes)}\n${fa.noLogs}`, {
            ok: true,
            app,
            source,
            lines: [],
          });
        }

        const counts = sliced.reduce<Record<string, number>>((acc, l) => {
          acc[l.level] = (acc[l.level] ?? 0) + 1;
          return acc;
        }, {});
        const body = sliced
          .slice(-30)
          .map((l) => `• [${l.level}]${l.ts ? ` ${l.ts}` : ""} ${l.message}`)
          .join("\n");

        return result(
          [
            `${fa.logsHeader(app, sinceMinutes)}`,
            `📊 ترکیب سطح: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join("، ")} (منبع: ${source})`,
            body,
            sliced.length > 30 ? `… و ${sliced.length - 30} خط دیگر (در structuredContent آمده است).` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          { ok: true, app, source, count: sliced.length, counts, logs: sliced },
        );
      }),
  );

  /* ── liara_metrics ───────────────────────────────────────────────── */
  server.registerTool(
    "liara_metrics",
    {
      title: "متریک‌های CPU و حافظهٔ اپ",
      description:
        "دریافت سری زمانی CPU و حافظهٔ اپ به‌همراه کمینه/میانگین/بیشینه/آخرین مقدار و شیب روند. فقط‌خواندنی.",
      inputSchema: {
        app: z.string().min(1).describe("نام اپ در لیارا"),
        sinceMinutes: z.number().int().min(1).max(1440).default(30).describe("بازهٔ زمانی به دقیقه"),
      },
      annotations: READ_ONLY,
    },
    async ({ app, sinceMinutes }) =>
      audited("liara_metrics", app, { app, sinceMinutes }, async () => {
        const results = await Promise.allSettled([
          liaraGet<unknown>(EP.metricsCpu(app), { query: { since: sinceMinutes } }),
          liaraGet<unknown>(EP.metricsMemory(app), { query: { since: sinceMinutes } }),
          liaraGet<unknown>(EP.metricsSummary(app), { query: { since: sinceMinutes } }),
        ]);

        const pick = (i: number): unknown => {
          const r = results[i];
          return r?.status === "fulfilled" ? r.value.data : undefined;
        };

        const cpu: Series | null = parseSeries(pick(0), "cpu", "%");
        const memory: Series | null = parseSeries(pick(1), "memory", "MB");
        const summary = pick(2);

        const describe = (s: Series | null): string => {
          if (!s || !s.points.length) return "—";
          const values = s.points.map((p) => p.value);
          const min = Math.min(...values);
          const max = Math.max(...values);
          const avg = values.reduce((a, b) => a + b, 0) / values.length;
          const last = values[values.length - 1]!;
          return `کمینه ${round(min)} / میانگین ${round(avg)} / بیشینه ${round(max)} / آخرین ${round(last)} / شیب ${round(slope(s.points))} (${s.points.length} نمونه؛ ${s.unit})`;
        };

        const unavailable: string[] = [];
        if (!cpu) unavailable.push("CPU");
        if (!memory) unavailable.push("حافظه");

        const lines = [
          `${fa.metricsHeader(app)}`,
          `• CPU: ${describe(cpu)}`,
          `• حافظه: ${describe(memory)}`,
          summary ? `• خلاصه: ${safeJson(summary).slice(0, 400)}` : "",
          unavailable.length ? `⚠️ ${fa.metricsUnavailable} (${unavailable.join("، ")})` : "",
        ].filter(Boolean);

        return result(lines.join("\n"), {
          ok: true,
          app,
          cpu,
          memory,
          summary,
          unavailable,
        });
      }),
  );

  /* ── liara_events ────────────────────────────────────────────────── */
  server.registerTool(
    "liara_events",
    {
      title: "رویدادهای اپ",
      description:
        "رویدادهای اپ (کرش، OOM، استقرار، تغییر مقیاس و ...) — مهم‌ترین منبع شواهد برای تشخیص رخداد. فقط‌خواندنی.",
      inputSchema: {
        app: z.string().min(1).describe("نام اپ در لیارا"),
      },
      annotations: READ_ONLY,
    },
    async ({ app }) =>
      audited("liara_events", app, { app }, async () => {
        const { data } = await liaraGet<unknown>(EP.events(app));
        const events: EventItem[] = parseEvents(data);
        if (!events.length) return result(`${fa.eventsHeader(app)}\n${fa.noEvents}`, { ok: true, events: [] });
        const lines = events
          .slice(-40)
          .map((e) => `• ${e.ts ? faTime(e.ts) : "—"} — ${e.type}: ${e.message}`);
        return result(`${fa.eventsHeader(app)}\n${bullets(lines)}`, { ok: true, app, events });
      }),
  );

  /* ── liara_plans ─────────────────────────────────────────────────── */
  server.registerTool(
    "liara_plans",
    {
      title: "پلن‌های موجود لیارا",
      description:
        "فهرست پلن‌های قابل استفاده در حساب (از GET /v1/me — لیارا endpoint جداگانهٔ plans ندارد). فقط‌خواندنی.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () =>
      audited("liara_plans", undefined, {}, async () => {
        const { data } = await liaraGet<unknown>(EP.me);
        const plans = parsePlans(data);
        if (!plans.length) {
          return result(
            `${fa.plansHeader}\n⚠️ ساختار پلن‌ها در پاسخ API متفاوت بود؛ جزئیات در structuredContent آمده است.`,
            { ok: true, plans: [], raw: data },
          );
        }
        const lines = plans.map(
          (p) =>
            `• ${p.planID}${p.name ? ` (${p.name})` : ""} — RAM: ${p.ramMB ? `${p.ramMB}MB` : "?"} | CPU: ${p.cpuCores ? `${p.cpuCores} هسته` : "?"}${p.price ? ` | قیمت: ${p.price}` : ""}${p.region ? ` | منطقه: ${p.region}` : ""}`,
        );
        return result(`${fa.plansHeader}\n${bullets(lines)}`, { ok: true, plans });
      }),
  );

  /* ── liara_releases ──────────────────────────────────────────────── */
  server.registerTool(
    "liara_releases",
    {
      title: "تاریخچهٔ انتشارهای اپ",
      description: "فهرست انتشارهای (release) یک اپ لیارا به‌همراه وضعیت و شناسه. فقط‌خواندنی.",
      inputSchema: {
        app: z.string().min(1).describe("نام اپ در لیارا"),
      },
      annotations: READ_ONLY,
    },
    async ({ app }) =>
      audited("liara_releases", app, { app }, async () => {
        const { data } = await liaraGet<unknown>(EP.listReleases(app));
        const rows = rowsOf(data);
        if (!rows.length) return result(`${fa.releasesHeader(app)}\n${fa.noReleases}`, { ok: true, releases: [] });
        const lines = rows.slice(-20).map((r) => {
          const o = (r ?? {}) as Record<string, unknown>;
          const id = str(o, ["releaseID", "id", "_id"]) ?? "—";
          const status = str(o, ["status", "state"]) ?? "—";
          const created = str(o, ["created_at", "createdAt", "date"]);
          const message = str(o, ["message", "description"]);
          return `• ${id} — ${status}${created ? ` — ${faTime(created)}` : ""}${message ? ` — ${message}` : ""}`;
        });
        return result(`${fa.releasesHeader(app)}\n${bullets(lines)}`, { ok: true, app, releases: rows });
      }),
  );

  /* ── http_probe ──────────────────────────────────────────────────── */
  server.registerTool(
    "http_probe",
    {
      title: "پروب سلامت HTTP",
      description:
        "چند درخواست HTTP به آدرس زندهٔ اپ و گزارش کد پاسخ و تأخیر. فقط دامنه‌های متصل به اپ‌های مجاز مجاز است.",
      inputSchema: {
        target: z
          .string()
          .min(1)
          .describe("نام اپ (مثلاً agate-liara) یا آدرس کامل https://<app>.liara.run"),
        path: z.string().default("/health").describe("مسیر بررسی (پیش‌فرض: /health)"),
        count: z.number().int().min(1).max(10).default(3).describe("تعداد نمونه‌ها (پیش‌فرض: ۳)"),
      },
      annotations: READ_ONLY,
    },
    async ({ target, path, count }) =>
      audited("http_probe", target, { target, path, count }, async () => {
        const probe = await httpProbe(target, { path, count });
        if ("error" in probe) return result(probe.error, { ok: false });
        return result(
          [
            `${fa.probeHeader(probe.url)}`,
            probeSummary(probe),
            `p50: ${probe.p50 ?? "—"}ms`,
          ].join("\n"),
          { ok: true, probe },
        );
      }),
  );

  /* ── audit_tail ──────────────────────────────────────────────────── */
  server.registerTool(
    "audit_tail",
    {
      title: "لاگ ممیزی",
      description:
        "نمایش N خط آخر لاگ ممیزی Agate-Liara (ابزار، اپ، وضعیت تأیید، مدت اجرا). فقط‌خواندنی.",
      inputSchema: {
        n: z.number().int().min(1).max(200).default(20).describe("تعداد خطوط (پیش‌فرض: ۲۰)"),
      },
      annotations: READ_ONLY,
    },
    async ({ n }) =>
      audited("audit_tail", undefined, { n }, async () => {
        const entries = readAuditTail(n);
        if (!entries.length) {
          return result("📋 لاگ ممیزی خالی است (هنوز ابزاری اجرا نشده).", { ok: true, entries: [] });
        }
        const lines = entries.map(
          (e) =>
            `• ${faTime(e.ts)} — ${e.tool}${e.app ? `(${e.app})` : ""} — تأیید: ${e.approval} — ${e.result} — ${e.durationMs}ms${e.detail ? ` — ${e.detail.slice(0, 120)}` : ""}`,
        );
        return result(`📋 لاگ ممیزی (${entries.length} خط)\n${bullets(lines)}`, { ok: true, entries });
      }),
  );

}

function round(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
