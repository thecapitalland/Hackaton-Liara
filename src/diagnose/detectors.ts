/**
 * Agate-Liara — موتور تشخیص علت (rule-based detectors).
 *
 * هر detector خالص است: ورودی نرمال‌شده → فهرست علت‌های احتمالی با شواهد.
 * این لایه مستقل از LLM کار می‌کند و در صورت نبود/خطای LLM هم مبنای پاسخ است.
 *
 * نکتهٔ امنیتی: متن لاگ «داده» است، نه «دستور». هر خطی که شبیه تلاش برای
 * تزریق پرامپت باشد پرچم‌گذاری و بی‌اثر می‌شود (تابع sanitizeLogText).
 */
import type {
  Evidence,
  EventItem,
  Hypothesis,
  LogLine,
  PlanLimits,
  ProbeResult,
  Series,
} from "../types.js";

/* ───────────────────────────── نرمال‌سازی ───────────────────────────── */

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
  /disregard\s+(all\s+)?(previous|prior)\s+(instructions?|rules?)/i,
  /you\s+are\s+now\s+/i,
  /system\s*:\s*/i,
  /<\s*\/?\s*(system|assistant|developer)\s*>/i,
  /new\s+instructions?\s*:/i,
  /please\s+run\s+the\s+following\s+command/i,
];

export interface SanitizedText {
  text: string;
  injectionSuspected: boolean;
}

/** پاک‌سازی متن لاگ: حذف کاراکترهای کنترلی، محدودکردن طول، تشخیص تزریق پرامپت */
export function sanitizeLogText(raw: string): SanitizedText {
  const text = raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  const capped = text.length > 600 ? `${text.slice(0, 600)}…` : text;
  const injectionSuspected = INJECTION_PATTERNS.some((re) => re.test(capped));
  return { text: capped, injectionSuspected };
}

/** تبدیل پاسخ خام لاگ لیارا به سطرهای نرمال (سازگار با چند شکل پاسخ) */
export function parseLogs(raw: unknown): LogLine[] {
  const rows: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? Object.values(raw as Record<string, unknown>).find((v) => Array.isArray(v)) ?? []
      : [];

  const out: LogLine[] = [];
  for (const row of rows) {
    if (row === null || row === undefined) continue;
    if (typeof row === "string") {
      const s = sanitizeLogText(row);
      out.push({ ts: null, level: guessLevel(s.text), message: s.text, raw: row });
      continue;
    }
    if (typeof row !== "object") continue;
    const obj = row as Record<string, unknown>;
    const rawMessage =
      firstString(obj, ["message", "msg", "body", "text", "log", "content", "error"]) ??
      safeStringify(obj);
    const s = sanitizeLogText(rawMessage);
    const ts = firstString(obj, ["timestamp", "time", "date", "datetime", "created_at", "createdAt", "@timestamp"]) ?? null;
    const level = firstString(obj, ["level", "severity", "levelname"]) ?? guessLevel(s.text);
    out.push({ ts, level, message: s.text, raw: row });
  }
  return out;
}

/** تبدیل پاسخ خام رویدادها به سطرهای نرمال */
export function parseEvents(raw: unknown): EventItem[] {
  const rows: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? Object.values(raw as Record<string, unknown>).find((v) => Array.isArray(v)) ?? []
      : [];

  const out: EventItem[] = [];
  for (const row of rows) {
    if (row === null || row === undefined) continue;
    if (typeof row === "string") {
      const s = sanitizeLogText(row);
      out.push({ ts: null, type: guessLevel(s.text), message: s.text, raw: row });
      continue;
    }
    if (typeof row !== "object") continue;
    const obj = row as Record<string, unknown>;
    const type = firstString(obj, ["type", "event", "eventType", "name", "status", "action"]) ?? "unknown";
    const message =
      firstString(obj, ["message", "msg", "description", "detail", "reason", "body", "text"]) ?? type;
    const s = sanitizeLogText(message);
    const ts = firstString(obj, ["timestamp", "time", "date", "datetime", "created_at", "createdAt"]) ?? null;
    out.push({ ts, type, message: s.text, raw: obj });
  }
  return out;
}

/** تبدیل پاسخ خام متریک به سری زمانی عددی */
export function parseSeries(raw: unknown, name: string, unit: string): Series | null {
  let rows: unknown[] = [];
  if (Array.isArray(raw)) rows = raw;
  else if (raw && typeof raw === "object") {
    const candidates = ["data", "result", "series", "points", "values", name];
    for (const key of candidates) {
      const v = (raw as Record<string, unknown>)[key];
      if (Array.isArray(v)) {
        rows = v;
        break;
      }
    }
    if (!rows.length) {
      const nested = Object.values(raw as Record<string, unknown>).find((v) => Array.isArray(v));
      if (Array.isArray(nested)) rows = nested;
    }
  }
  if (!rows.length) return null;

  const points: { ts: string | null; value: number }[] = [];
  for (const row of rows) {
    if (typeof row === "number" && Number.isFinite(row)) {
      points.push({ ts: null, value: row });
      continue;
    }
    if (typeof row !== "object" || row === null) continue;
    const obj = row as Record<string, unknown>;
    const value = firstNumber(obj, [
      "value",
      "avg",
      "average",
      "mean",
      "usage",
      "utilization",
      "percent",
      "cpu",
      "memory",
      "mem",
      "ram",
      "value.average",
      "valueAverage",
    ]);
    if (value === null) continue;
    const ts = firstString(obj, ["timestamp", "time", "date", "datetime", "t"]) ?? null;
    points.push({ ts, value });
  }
  if (!points.length) return null;
  return { name, unit, points };
}

/* ───────────────────────────── ابزارهای عددی ───────────────────────── */

/** شیب رگرسیون خطی (به ازای هر نقطه) */
export function slope(points: { value: number }[]): number {
  const n = points.length;
  if (n < 2) return 0;
  const xs = points.map((_, i) => i);
  const ys = points.map((p) => p.value);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - meanX) * (ys[i]! - meanY);
    den += (xs[i]! - meanX) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/** آیا سری تقریباً یکنواخت صعودی است؟ (بیش از ۷۰٪ گام‌ها صعودی و شیب مثبت) */
export function isRising(points: { value: number }[]): boolean {
  if (points.length < 3) return false;
  let up = 0;
  let down = 0;
  for (let i = 1; i < points.length; i++) {
    const d = points[i]!.value - points[i - 1]!.value;
    if (d > 0) up++;
    else if (d < 0) down++;
  }
  const total = up + down;
  if (total === 0) return false;
  return up / total >= 0.7 && slope(points) > 0;
}

/** میانگین سری */
export function average(points: { value: number }[]): number {
  if (!points.length) return 0;
  return points.reduce((a, p) => a + p.value, 0) / points.length;
}

/** کمینه/بیشینه/آخرین مقدار */
export function stats(points: { value: number }[]): { min: number; max: number; last: number; avg: number } {
  if (!points.length) return { min: 0, max: 0, last: 0, avg: 0 };
  const values = points.map((p) => p.value);
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    last: values[values.length - 1]!,
    avg: average(points),
  };
}

/**
 * نرمال‌سازی CPU به درصد.
 * اگر داده‌ها تعداد هسته باشند (کمینه و بیشینه ≤ تعداد هسته) درصدِ مصرفِ
 * یک هسته محاسبه می‌شود؛ در غیر این صورت مقدار همان درصد فرض می‌شود.
 */
export function cpuPercent(series: Series | null, plan?: PlanLimits | null): { avg: number; max: number; last: number } | null {
  if (!series || !series.points.length) return null;
  const s = stats(series.points);
  const cores = plan?.cpuCores && plan.cpuCores > 0 ? plan.cpuCores : undefined;
  let avg = s.avg;
  let max = s.max;
  if (cores && max <= cores && max > 0) {
    avg = (avg / cores) * 100;
    max = (max / cores) * 100;
  } else if (max <= 1.0001 && max > 0) {
    // داده‌ها به‌صورت نسبت (0..1)
    avg *= 100;
    max *= 100;
  }
  return { avg, max, last: s.last };
}

/* ───────────────────────────── تشخیص ───────────────────────────── */

export interface DetectionInput {
  app: string;
  logs: LogLine[];
  events: EventItem[];
  cpu: Series | null;
  memory: Series | null;
  probe: ProbeResult | null;
  env: { defined: string[]; required: string[] } | null;
  plan?: PlanLimits | null;
  collectedAt?: string;
}

interface Detector {
  id: string;
  run(ctx: DetectionCtx): Hypothesis | null;
}

interface DetectionCtx {
  input: DetectionInput;
  evidence: Evidence[];
  now: string;
  addEvidence(source: Evidence["source"], observation: string, available?: boolean): string;
}

function createCtx(input: DetectionInput): DetectionCtx {
  const now = input.collectedAt ?? new Date().toISOString();
  const evidence: Evidence[] = [];
  let counter = 0;
  return {
    input,
    evidence,
    now,
    addEvidence(source, observation, available = true) {
      counter += 1;
      const id = `ev_${source}_${counter}`;
      evidence.push({ id, source, observation, available, collectedAt: now });
      return id;
    },
  };
}

function pct(n: number): string {
  return `${Math.round(n * 10) / 10}%`;
}

/* ── detector: نشت حافظه ──────────────────────────────────────────── */
const memoryLeak: Detector = {
  id: "memory_leak",
  run(ctx) {
    const { memory, logs, plan } = ctx.input;
    const evidenceIds: string[] = [];
    let confidence = 0;
    const notes: string[] = [];

    const leakLogs = logs.filter((l) => /heap|\[BUG\]\s*leak|memory\s+leak/i.test(l.message));
    if (leakLogs.length) {
      evidenceIds.push(
        ctx.addEvidence(
          "logs",
          `در لاگ‌ها نشانهٔ رشد/نشت حافظه دیده شد (${leakLogs.length} خط): «${leakLogs[0]!.message.slice(0, 180)}»`,
        ),
      );
      confidence += 0.35;
      notes.push("لاگ صراحتاً رشد حافظه را گزارش کرده است.");
    }

    if (memory && memory.points.length >= 5) {
      const s = stats(memory.points);
      const rising = isRising(memory.points);
      const sl = slope(memory.points);
      evidenceIds.push(
        ctx.addEvidence(
          "metrics",
          `حافظه: کمینه ${round(s.min)} ${memory.unit}، بیشینه ${round(s.max)}، میانگین ${round(s.avg)}، آخرین ${round(s.last)}؛ روند ${rising ? "صعودی" : "نامشخص"} (شیب ${round(sl)} در هر نمونه)`,
        ),
      );
      if (rising) {
        confidence += 0.3;
        notes.push("سری حافظه در بازهٔ اخیر یکنواخت صعودی است.");
      }
      const planRam = plan?.ramMB;
      if (planRam && planRam > 0) {
        const lastMb = s.last;
        const pctOfPlan = (lastMb / planRam) * 100;
        evidenceIds.push(
          ctx.addEvidence(
            "metrics",
            `مصرف فعلی حافظه حدود ${pct(pctOfPlan)} از سقف پلن (${planRam} MB) است.`,
          ),
        );
        if (pctOfPlan > 80) {
          confidence += 0.3;
          notes.push(`مصرف حافظه از ۸۰٪ سقف پلن عبور کرده (${pct(pctOfPlan)}).`);
        }
      } else {
        notes.push("سقف حافظهٔ پلن از API به‌طور قطعی در دسترس نبود؛ سنجش نسبی انجام شد.");
      }
    } else {
      ctx.addEvidence("metrics", "سری حافظه در دسترس نبود یا کمتر از ۵ نمونه داشت.", false);
    }

    if (confidence < 0.3) return null;
    return {
      id: "memory_leak",
      rank: 0,
      cause: "نشت حافظه (رشد پیوستهٔ heap در طول زمان)",
      confidence: Math.min(0.95, confidence),
      evidenceIds,
      kind: leakLogs.length ? "observed" : "inferred",
      remedies: ["restart", "resize", "code_fix"],
      remedyText: [
        "ری‌استارت سرویس: سریع و موقت؛ حافظه آزاد می‌شود ولی علت باقی می‌ماند.",
        "ارتقای پلن: حاشیهٔ حافظه را بیشتر می‌کند ولی نشت را برطرف نمی‌کند.",
        "اصلاح کد و دیپلوی مجدد: راه‌حل دائمی — نگهداری buffer/leak در حافظهٔ global.",
      ],
    };
  },
};

/* ── detector: OOM ────────────────────────────────────────────────── */
const oom: Detector = {
  id: "oom",
  run(ctx) {
    const { logs, events } = ctx.input;
    const evidenceIds: string[] = [];
    let confidence = 0;

    const oomLogs = logs.filter((l) =>
      /JavaScript heap out of memory|heap out of memory|out of memory|OOMKilled/i.test(l.message),
    );
    if (oomLogs.length) {
      evidenceIds.push(
        ctx.addEvidence("logs", `OOM در لاگ ثبت شد: «${oomLogs[0]!.message.slice(0, 200)}»`),
      );
      confidence += 0.55;
    }

    const oomEvents = events.filter((e) =>
      /oom|out of memory|killed|memory limit|exit code 137/i.test(`${e.type} ${e.message}`),
    );
    if (oomEvents.length) {
      evidenceIds.push(
        ctx.addEvidence(
          "events",
          `${oomEvents.length} رویداد کشته‌شدن/OOM: «${oomEvents[0]!.type} — ${oomEvents[0]!.message.slice(0, 160)}»`,
        ),
      );
      confidence += 0.3;
    }

    if (confidence < 0.3) return null;
    return {
      id: "oom",
      rank: 0,
      cause: "سرریز حافظه (OOM) و کشته‌شدن کانتینر",
      confidence: Math.min(0.95, confidence),
      evidenceIds,
      kind: "observed",
      remedies: ["restart", "resize", "code_fix"],
      remedyText: [
        "ری‌استارت سرویس: سرویس را بالا می‌آورد ولی علت ریشه‌ای پابرجاست.",
        "ارتقای پلن: اگر نشت نیست و بار واقعی از سقف پلن بیشتر است، راه درست است.",
        "اصلاح کد و دیپلوی مجدد: حذف مسیر نشت یا آزادسازی buffer.",
      ],
    };
  },
};

/* ── detector: محدودیت CPU ────────────────────────────────────────── */
const cpuThrottle: Detector = {
  id: "cpu_throttle",
  run(ctx) {
    const { cpu, plan } = ctx.input;
    if (!cpu || !cpu.points.length) {
      ctx.addEvidence("metrics", "سری CPU در دسترس نبود.", false);
      return null;
    }
    const c = cpuPercent(cpu, plan);
    if (!c) return null;
    const evidenceIds = [
      ctx.addEvidence(
        "metrics",
        `CPU: میانگین ${pct(c.avg)}، بیشینه ${pct(c.max)}، آخرین ${pct(c.last)}${plan?.cpuCores ? ` (${plan.cpuCores} هسته)` : ""}`,
      ),
    ];
    if (c.avg <= 85) return null;
    return {
      id: "cpu_throttle",
      rank: 0,
      cause: "محدودیت CPU (میانگین مصرف بالای ۸۵٪)",
      confidence: Math.min(0.9, 0.4 + (c.avg - 85) / 100 + 0.1),
      evidenceIds,
      kind: "observed",
      remedies: ["resize", "code_fix", "restart"],
      remedyText: [
        "ارتقای پلن: افزایش هسته‌ها، اثر فوری ولی هزینه‌بر.",
        "اصلاح کد: کاهش کار محاسباتی/افزودن cache.",
        "ری‌استارت: موقتاً بار را صفر می‌کند ولی علت را حل نمی‌کند.",
      ],
    };
  },
};

/* ── detector: کندی پاسخ ──────────────────────────────────────────── */
const slowResponses: Detector = {
  id: "slow_responses",
  run(ctx) {
    const { probe, cpu } = ctx.input;
    if (!probe || probe.p50 === null) {
      ctx.addEvidence("probe", "پروب سلامت در دسترس نبود.", false);
      return null;
    }
    const cpuStat = cpuPercent(cpu, ctx.input.plan);
    const cpuNormal = cpuStat ? cpuStat.avg <= 85 : true;
    const evidenceIds = [
      ctx.addEvidence(
        "probe",
        `زمان پاسخ ${probe.url}: p50=${round(probe.p50)}ms (${probe.samples.length} نمونه)`,
      ),
    ];
    if (cpuStat) {
      evidenceIds.push(ctx.addEvidence("metrics", `میانگین CPU ${pct(cpuStat.avg)} — ${cpuNormal ? "نرمال" : "بالا"}.`));
    }
    if (probe.p50 <= 1500) return null;
    return {
      id: "slow_responses",
      rank: 0,
      cause: "کندی پاسخ (p50 بالای ۱۵۰۰ms) با CPU در محدودهٔ نرمال",
      confidence: cpuNormal ? 0.6 : 0.3,
      evidenceIds,
      kind: "observed",
      remedies: ["code_fix", "restart", "resize"],
      remedyText: [
        "اصلاح کد: بررسی مسیرهای کند (I/O بلاکینگ، دیتابیس، فراخوانی خارجی).",
        "ری‌استارت: پاک‌کردن وضعیت انباشته و حافظه.",
        "ارتقای پلن: فقط اگر محدودیت منابع تأیید شود.",
      ],
    };
  },
};

/* ── detector: خطای ۵xx ───────────────────────────────────────────── */
const http5xx: Detector = {
  id: "http_5xx",
  run(ctx) {
    const { probe, logs } = ctx.input;
    const evidenceIds: string[] = [];
    let confidence = 0;

    const badSamples = probe?.samples.filter((s) => (s.status ?? 0) >= 500) ?? [];
    if (badSamples.length) {
      evidenceIds.push(
        ctx.addEvidence(
          "probe",
          `${badSamples.length} از ${probe?.samples.length ?? 0} پروب با خطای ${badSamples[0]!.status} پاسخ داد.`,
        ),
      );
      confidence += 0.4;
    }

    const errorLogs = logs.filter((l) =>
      /\bError\b|at\s+\w+\s+\(|status=5\d\d|status code 5\d\d|stack trace|\bECONN|\bETIMEDOUT/i.test(
        l.message,
      ),
    );
    if (errorLogs.length) {
      evidenceIds.push(
        ctx.addEvidence(
          "logs",
          `${errorLogs.length} خطا/استک در لاگ: «${errorLogs[0]!.message.slice(0, 200)}»`,
        ),
      );
      confidence += 0.3;
    }

    if (confidence < 0.35) return null;
    return {
      id: "http_5xx",
      rank: 0,
      cause: "خطای داخلی سرویس (HTTP 5xx) — استثنا در کد اپلیکیشن",
      confidence: Math.min(0.9, confidence),
      evidenceIds,
      kind: "observed",
      remedies: ["code_fix", "restart"],
      remedyText: [
        "اصلاح کد و دیپلوی مجدد: ریشهٔ خطا را برطرف می‌کند.",
        "ری‌استارت: اگر خطا وضعیتِ کهنه در حافظه باشد موقتاً کمک می‌کند.",
      ],
    };
  },
};

/* ── detector: متغیر محیطی ناقص ──────────────────────────────────── */
const missingEnv: Detector = {
  id: "missing_env",
  run(ctx) {
    const { logs, env } = ctx.input;
    const evidenceIds: string[] = [];
    let confidence = 0;

    const envLogs = logs.filter((l) =>
      /undefined is not an object|missing env|is not defined|ENV\s+[A-Z0-9_]+\s+not set|Cannot read properties of undefined/i.test(
        l.message,
      ),
    );
    if (envLogs.length) {
      evidenceIds.push(
        ctx.addEvidence("logs", `لاگ به متغیر محیطی/مقدار تعریف‌نشده اشاره دارد: «${envLogs[0]!.message.slice(0, 200)}»`),
      );
      confidence += 0.4;
    }

    if (env) {
      const missing = env.required.filter((k) => !env.defined.includes(k));
      const evidence = ctx.addEvidence(
        "env",
        missing.length
          ? `متغیرهای لازم که روی اپ تعریف نشده‌اند: ${missing.join("، ")}`
          : `همهٔ متغیرهای لازم تعریف شده‌اند (${env.required.join("، ") || "—"})`,
        true,
      );
      evidenceIds.push(evidence);
      if (missing.length) confidence += 0.35;
    }

    if (confidence < 0.35) return null;
    return {
      id: "missing_env",
      rank: 0,
      cause: "متغیر محیطی ضروری تنظیم نشده است",
      confidence: Math.min(0.92, confidence),
      evidenceIds,
      kind: "observed",
      remedies: ["set_env", "code_fix", "restart"],
      remedyText: [
        "تنظیم متغیر محیطی: تعریف کلیدهای لازم روی اپ (ری‌استارت لازم می‌شود).",
        "اصلاح کد: اگر مقدار باید در خود کد fallback داشته باشد.",
      ],
    };
  },
};

/* ── detector: حلقهٔ کرش ───────────────────────────────────────────── */
const crashLoop: Detector = {
  id: "crash_loop",
  run(ctx) {
    const { events } = ctx.input;
    const restarts = events.filter((e) => /restart|crash|kill|reboot|exit/i.test(`${e.type} ${e.message}`));
    if (restarts.length < 2) return null;
    const evidenceIds = [
      ctx.addEvidence(
        "events",
        `${restarts.length} رویداد ری‌استارت/کرش ثبت شد: «${restarts
          .slice(0, 3)
          .map((e) => `${e.type}${e.ts ? ` @${e.ts}` : ""}`)
          .join("، ")}»`,
      ),
    ];
    const withinWindow = restarts.filter((e) => e.ts && Date.now() - Date.parse(e.ts) <= 10 * 60 * 1000);
    if (withinWindow.length >= 2) {
      evidenceIds.push(ctx.addEvidence("events", `دست‌کم ${withinWindow.length} کرش در ۱۰ دقیقهٔ اخیر رخ داده است.`));
    }
    return {
      id: "crash_loop",
      rank: 0,
      cause: "حلقهٔ کرش / ری‌استارت‌های مکرر سرویس",
      confidence: withinWindow.length >= 2 ? 0.8 : 0.55,
      evidenceIds,
      kind: "observed",
      remedies: ["restart", "code_fix"],
      remedyText: [
        "ری‌استارت سرویس: وضعیت را برمی‌گرداند ولی اگر علت پایدار باشد تکرار می‌شود.",
        "اصلاح کد و دیپلوی مجدد: برای خطاهای زمان اجرا لازم است.",
      ],
    };
  },
};

const DETECTORS: Detector[] = [memoryLeak, oom, http5xx, missingEnv, crashLoop, cpuThrottle, slowResponses];

export interface DetectionResult {
  hypotheses: Hypothesis[];
  evidence: Evidence[];
}

/** اجرای همهٔ detectorها و رتبه‌بندی علت‌ها */
export function detectCauses(input: DetectionInput): DetectionResult {
  const ctx = createCtx(input);
  const found: Hypothesis[] = [];

  for (const det of DETECTORS) {
    try {
      const h = det.run(ctx);
      if (h) found.push(h);
    } catch {
      /* یک detector خراب نباید کل تحلیل را متوقف کند */
    }
  }

  found.sort((a, b) => b.confidence - a.confidence);
  const top = found.slice(0, 3).map((h, i) => ({ ...h, rank: i + 1 }));

  return { hypotheses: top, evidence: ctx.evidence };
}

/* ───────────────────────────── کمکی‌ها ───────────────────────────── */

function round(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function guessLevel(text: string): string {
  if (/\b(error|fatal|exception|panic)\b/i.test(text)) return "error";
  if (/\bwarn(ing)?\b/i.test(text)) return "warn";
  if (/\b(info|notice)\b/i.test(text)) return "info";
  if (/\b(debug|trace)\b/i.test(text)) return "debug";
  return "info";
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length) return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return undefined;
}
function firstNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = Number.parseFloat(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
