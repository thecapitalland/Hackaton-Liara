/**
 * Agate-Liara — پروب سلامت HTTP.
 *
 * محدودیت امنیتی: فقط `https://<app>.liara.run` یا دامنه‌های متصل به اپ‌های
 * مجاز پروب می‌شوند (SSRF/دامنهٔ آزاد ممنوع).
 */
import { config, isAllowedApp } from "./config.js";
import { liaraGet } from "./liara/client.js";
import { EP } from "./liara/endpoints.js";
import type { ProbeResult, ProbeSample } from "./types.js";

/** فقط HTTPS و دامنه‌های معتبر */
export function isSafeTarget(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  return true;
}

/** دامنه‌های متصل به اپ‌های مجاز (با کش کوتاه‌مدت) */
let domainCache: { at: number; hosts: Set<string> } | null = null;

export async function allowedHosts(): Promise<Set<string>> {
  const now = Date.now();
  if (domainCache && now - domainCache.at < 60_000) return domainCache.hosts;

  const hosts = new Set<string>();
  for (const app of config.allowedApps) {
    hosts.add(`${app}.liara.run`);
    try {
      const { data } = await liaraGet<unknown>(EP.listDomains, {
        query: { project: app },
      });
      const rows = Array.isArray(data)
        ? data
        : (data as { data?: unknown[] })?.data ?? [];
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const obj = row as Record<string, unknown>;
        const name = typeof obj["name"] === "string" ? (obj["name"] as string) : undefined;
        if (name) hosts.add(name.toLowerCase());
      }
    } catch {
      /* بدون توکن یا خطای شبکه: فقط *.liara.run مجاز می‌ماند */
    }
  }
  domainCache = { at: now, hosts };
  return hosts;
}

/** ساخت URL هدف از نام اپ یا URL کامل */
export async function resolveTarget(target: string): Promise<{ url: string; error?: string }> {
  const raw = target.trim();
  if (/^https?:\/\//i.test(raw)) {
    const url = raw.replace(/\/+$/, "");
    if (!isSafeTarget(url)) {
      return { url, error: "❌ فقط آدرس‌های HTTPS مجاز است." };
    }
    const parsed = new URL(url);
    const hosts = await allowedHosts();
    if (!hosts.has(parsed.hostname.toLowerCase())) {
      return {
        url,
        error: `❌ دامنهٔ «${parsed.hostname}» به اپ‌های مجاز متصل نیست؛ پروب انجام نشد.`,
      };
    }
    return { url };
  }

  const app = raw.replace(/\.liara\.run$/i, "");
  if (!isAllowedApp(app)) {
    return {
      url: "",
      error: `❌ اپ «${raw}» در لیست مجاز نیست (مجاز: ${config.allowedApps.join("، ")}).`,
    };
  }
  return { url: `https://${app}.liara.run` };
}

export interface ProbeOptions {
  count?: number;
  path?: string;
  timeoutMs?: number;
  gapMs?: number;
}

/** اجرای چند پروب پشت‌سرهم و جمع‌کردن آمار */
export async function httpProbe(target: string, opts: ProbeOptions = {}): Promise<ProbeResult | { error: string }> {
  const count = Math.min(Math.max(opts.count ?? 3, 1), 10);
  const path = opts.path ?? "/health";
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const gapMs = opts.gapMs ?? 300;

  const resolved = await resolveTarget(target);
  if (resolved.error) return { error: resolved.error };

  const base = resolved.url;
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  const samples: ProbeSample[] = [];

  for (let i = 0; i < count; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers: { Accept: "application/json,text/plain;q=0.9,*/*;q=0.8" },
        signal: controller.signal,
      });
      // بدنه خوانده می‌شود ولی فقط برای آزادکردن اتصال
      await res.text().catch(() => "");
      samples.push({ status: res.status, latencyMs: Date.now() - started });
    } catch (err) {
      const e = err as Error;
      samples.push({
        status: null,
        latencyMs: Date.now() - started,
        error: e?.name === "AbortError" ? "timeout" : (e?.message ?? "network error"),
      });
    } finally {
      clearTimeout(timer);
    }
    if (i < count - 1) await sleep(gapMs);
  }

  const latencies = samples
    .map((s) => s.latencyMs)
    .filter((v): v is number => typeof v === "number")
    .sort((a, b) => a - b);
  const p50 = latencies.length ? latencies[Math.floor(latencies.length / 2)]! : null;

  const ok = samples.length > 0 && samples.every((s) => (s.status ?? 0) >= 200 && (s.status ?? 0) < 400);

  return {
    url,
    samples,
    ok,
    p50,
    errorText: ok ? undefined : samples.find((s) => s.status === null)?.error,
  };
}

/** خلاصهٔ فارسی پروب */
export function probeSummary(result: ProbeResult): string {
  const lines = result.samples.map(
    (s) =>
      `  • ${s.status ?? "—"} در ${s.latencyMs ?? "—"}ms${s.error ? ` (${s.error})` : ""}`,
  );
  const head = result.ok
    ? `✅ پاسخ سالم (p50=${result.p50 ?? "—"}ms)`
    : `❌ پاسخ ناسالم (p50=${result.p50 ?? "—"}ms)`;
  return [head, ...lines].join("\n");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
