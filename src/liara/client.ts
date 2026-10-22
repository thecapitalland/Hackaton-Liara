/**
 * Agate-Liara — پوشش نازک روی fetch برای API لیارا.
 *
 * قوانین:
 *  • Authorization: Bearer <token> — هرگز لاگ نمی‌شود.
 *  • `?teamID=<id>` روی همهٔ درخواست‌ها (اگر تنظیم شده باشد).
 *  • مهلت ۲۰ ثانیه؛ برای GET یک‌بار تلاش مجدد روی خطای شبکه/۵xx.
 *  • خطاها به پیام فارسی نگاشت می‌شوند.
 */
import { config, hasToken } from "../config.js";
import { fa } from "../i18n/fa.js";
import { ERR } from "./endpoints.js";
import { assertPreflight } from './preflight-gate.js';

export type ErrorCode =
  | "AUTH_REQUIRED"
  | "NOT_FOUND"
  | "API_RATE_LIMIT"
  | "API_UNAVAILABLE"
  | "NETWORK"
  | "TIMEOUT"
  | "BAD_REQUEST"
  | "CONFLICT"
  | "UNKNOWN_PROVIDER_RESULT";

export class LiaraError extends Error {
  readonly code: ErrorCode;
  readonly status?: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, status?: number, details?: unknown) {
    super(message);
    this.name = "LiaraError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface LiaraResponse<T = unknown> {
  status: number;
  data: T;
  /** base url واقعی که پاسخ از آن آمد */
  base: string;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** هدرهای اضافه (Authorization خودکار اضافه می‌شود) */
  headers?: Record<string, string>;
  /** timeout override */
  timeoutMs?: number;
  /** base override (مثلاً DNS service) */
  base?: string;
  /** fallback base در صورت خطای شبکه */
  fallbackBase?: string;
  /** نام سرویس برای پیام خطا */
  service?: "liara" | "dns";
  /** آیا عملیات نوشتنی است (تلاش مجدد نمی‌شود) */
  write?: boolean;
}

/** ساخت URL نهایی با teamID */
export function buildUrl(
  base: string,
  pathname: string,
  query?: RequestOptions["query"],
): string {
  const url = new URL(pathname.startsWith("/") ? pathname : `/${pathname}`, base);
  if (url.origin !== new URL(base).origin) throw new Error('مسیر API نمی‌تواند میزبان را تغییر دهد.');
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, String(v));
    }
  }
  if (config.teamId) url.searchParams.set("teamID", config.teamId);
  return url.toString();
}

function headersFor(opts: RequestOptions): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${config.token}`,
    ...(opts.headers ?? {}),
  };
  return h;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorFor(status: number, body: unknown): LiaraError {
  const messageFa =
    (body && typeof body === "object" && "message" in body
      ? String((body as { message: unknown }).message)
      : "") || "";

  switch (status) {
    case 401:
    case 403:
      return new LiaraError(ERR.AUTH_REQUIRED, fa.auth, status, body);
    case 404:
      return new LiaraError(ERR.NOT_FOUND, fa.notFound, status, body);
    case 429:
      return new LiaraError(ERR.RATE_LIMIT, fa.rateLimit, status, body);
    case 400:
    case 422:
      return new LiaraError(
        ERR.BAD_REQUEST,
        messageFa ? `❌ ${messageFa}` : fa.badRequest,
        status,
        body,
      );
    case 409:
      return new LiaraError(ERR.CONFLICT, fa.conflict, status, body);
    default:
      if (status >= 500) {
        return new LiaraError(
          ERR.API_UNAVAILABLE,
          messageFa ? `❌ ${messageFa}` : fa.serverError,
          status,
          body,
        );
      }
      return new LiaraError(
        ERR.UNKNOWN,
        messageFa ? `❌ ${messageFa}` : fa.unknown,
        status,
        body,
      );
  }
}

async function attempt<T>(
  base: string,
  pathname: string,
  opts: RequestOptions,
): Promise<LiaraResponse<T>> {
  const method = opts.method ?? "GET";
  const url = buildUrl(base, pathname, opts.query);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? config.requestTimeoutMs,
  );
  try {
    const init: RequestInit = {
      method,
      headers: headersFor(opts),
      signal: controller.signal,
      redirect: 'error',
    };
    if (opts.body !== undefined) {
      const isForm = opts.body instanceof FormData;
      init.body = isForm ? (opts.body as unknown as RequestInit["body"]) : JSON.stringify(opts.body);
      if (!isForm) {
        init.headers = { ...(init.headers as Record<string, string>), "Content-Type": "application/json" };
      }
    }
    const res = await fetch(url, init);
    const body = await readBody(res);
    if (!res.ok) throw errorFor(res.status, body);
    return { status: res.status, data: body as T, base };
  } catch (err) {
    if (err instanceof LiaraError) throw err;
    if ((err as Error)?.name === "AbortError") {
      throw new LiaraError(ERR.TIMEOUT, fa.timeout);
    }
    throw new LiaraError(ERR.NETWORK, fa.network, undefined, {
      cause: String((err as Error)?.message ?? err),
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * درخواست به API لیارا (یا DNS).
 * GET در صورت خطای شبکه/۵xx یک‌بار دیگر تلاش می‌شود (و در صورت نیاز با بیس جایگزین).
 */
export async function liaraRequest<T = unknown>(
  pathname: string,
  opts: RequestOptions = {},
): Promise<LiaraResponse<T>> {
  if (!hasToken()) {
    throw new LiaraError(ERR.AUTH_REQUIRED, fa.missingToken);
  }
  if ((opts.method ?? 'GET') !== 'GET') assertPreflight();
  const base = opts.base ?? config.apiBase;
  const fallbackBase = opts.fallbackBase ?? config.apiBaseFallback;
  const isGet = (opts.method ?? "GET") === "GET";

  try {
    return await attempt<T>(base, pathname, opts);
  } catch (err) {
    const e = err as LiaraError;
    const transient =
      e.code === ERR.NETWORK ||
      e.code === ERR.TIMEOUT ||
      (typeof e.status === "number" && e.status >= 500);

    if (isGet && transient && fallbackBase && fallbackBase !== base) {
      return attempt<T>(fallbackBase, pathname, opts);
    }
    if (isGet && transient) {
      // تلاش مجدد روی همان بیس (یک‌بار)
      return attempt<T>(base, pathname, opts);
    }
    throw e;
  }
}

/** میان‌بر GET */
export function liaraGet<T = unknown>(
  pathname: string,
  opts: RequestOptions = {},
): Promise<LiaraResponse<T>> {
  return liaraRequest<T>(pathname, { ...opts, method: "GET" });
}

/** میان‌بر POST */
export function liaraPost<T = unknown>(
  pathname: string,
  body?: unknown,
  opts: RequestOptions = {},
): Promise<LiaraResponse<T>> {
  return liaraRequest<T>(pathname, { ...opts, method: "POST", body, write: true });
}

/** آپلود سورس به‌صورت multipart (فیلد `file`) */
export async function uploadSource(
  app: string,
  archive: Buffer,
  filename = "source.tar.gz",
): Promise<{ sourceID: string; raw: unknown }> {
  const form = new FormData();
  const blob = new Blob([new Uint8Array(archive)], { type: "application/gzip" });
  form.append("file", blob, filename);

  const { data } = await liaraRequest<Record<string, unknown>>(
    `/v2/projects/${encodeURIComponent(app)}/sources`,
    { method: "POST", body: form, write: true },
  );

  const sourceID =
    (data?.["sourceID"] as string) ??
    (data?.["sourceId"] as string) ??
    ((data?.["source"] as Record<string, unknown>)?.["sourceID"] as string) ??
    "";

  if (!sourceID) {
    throw new LiaraError(
      ERR.UNKNOWN,
      "❌ پاسخ آپلود سورس شناسهٔ sourceID نداشت؛ ساختار پاسخ تغییر کرده است.",
      undefined,
      data,
    );
  }
  return { sourceID, raw: data };
}

/** ابزار کمکی: پیام خطای فارسی برای هر استثنا */
export function faErrorMessage(err: unknown): string {
  if (err instanceof LiaraError) return err.message;
  const e = err as Error;
  if (e?.name === "AbortError") return fa.timeout;
  return `${fa.unknown} (${e?.message ?? String(err)})`;
}
