/**
 * Agate Co. — سایت دموی هکاتون (Starcoach Agentic AI / چالش لیارا)
 *
 * هدف: یک اپلیکیشن واقعی که بتوان خرابش کرد و نشان داد Agate-Liara
 * آن را تشخیص می‌دهد، راهکار می‌دهد، بعد از تأیید درستش می‌کند و تأیید می‌گیرد.
 *
 * حالت‌های خرابی (قابل تغییر در زمان اجرا از پنل ادمین):
 *   off       — سالم
 *   leak      — نشت حافظه (هر ثانیه ~۵MB)
 *   slow      — تأخیر ۲ تا ۴ ثانیه در / و /api/*
 *   error500  — استثنای واقعی در / و /api/challenges (ولی /health سالم می‌ماند)
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const VALID_MODES = ["off", "leak", "slow", "error500"];

/** چالش‌های هکاتون — فقط محتوای نمایشی سایت (هیچ منطق Torob/Wallex پیاده نشده) */
const CHALLENGES = [
  {
    id: "liara",
    title: "لیارا",
    subtitle: "دستیار DevOps / SRE مبتنی بر MCP",
    accent: "cyan",
    tag: "پیاده‌سازی‌شده",
    description:
      "استقرار واقعی روی لیارا، جمع‌آوری لاگ و متریک، رتبه‌بندی علت رخداد، پیشنهاد راهکار و تأیید انسانی پیش از هر تغییر.",
    points: ["دیپلوی از صفر", "تشخیص ریشه‌ای", "تأیید اجباری", "تأیید پس از اصلاح"],
  },
  {
    id: "torob",
    title: "توروب",
    subtitle: "معرفی چالش بازارگاه ایران",
    accent: "amber",
    tag: "محتوای نمایشی",
    description:
      "کارت معرفی چالش توروب. طبق قواعد مسابقه، منطق تجاری این چالش پیاده‌سازی نشده و فقط محتوای معرفی در سایت نمایش داده می‌شود.",
    points: ["معرفی چالش", "بدون منطق تجاری", "محتوای ایستا"],
  },
  {
    id: "wallex",
    title: "والکس",
    subtitle: "معرفی چالش کیف پول دیجیتال",
    accent: "emerald",
    tag: "محتوای نمایشی",
    description:
      "کارت معرفی چالش والکس. طبق قواعد مسابقه، هیچ قابلیت ترید یا کیف پولی پیاده‌سازی نشده و فقط محتوای معرفی نمایش داده می‌شود.",
    points: ["معرفی چالش", "بدون قابلیت ترید", "محتوای ایستا"],
  },
];

/** وضعیت زمان اجرا */
const state = {
  bugMode: VALID_MODES.includes(process.env.BUG_MODE) ? process.env.BUG_MODE : "off",
  startedAt: Date.now(),
  /** نشت حافظه — عمداً هرگز خالی نمی‌شود */
  leakSink: [],
  leakTimer: null,
};

/* ─────────────────────────── ابزارهای کمکی ─────────────────────────── */

function memMB() {
  return Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10;
}

/** حافظهٔ خارج از heap (Bufferها) — نشت عمدی اینجاست */
function extMB() {
  return Math.round((process.memoryUsage().external / 1024 / 1024) * 10) / 10;
}

function rssMB() {
  return Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10;
}

function uptimeSec() {
  return Math.round((Date.now() - state.startedAt) / 1000);
}

function log(line) {
  process.stdout.write(`[${new Date().toISOString()}] ${line}\n`);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * ساخت کارت چالش‌ها.
 * ⚠️ مسیر باگ: در حالت error500 یکی از آیتم‌ها undefined می‌شود و
 * دسترسی به `.title` روی آن، استثنای واقعی می‌سازد.
 * (راه‌حل نمایشی: حذف این خط یا استفاده از optional chaining)
 */
function buildChallengeCards() {
  const cards = CHALLENGES.slice();
  if (state.bugMode === "error500") {
    cards[1] = undefined;
  }
  return cards
    .map((c) => {
      // دسترسی به title عمداً اولین دسترسی است تا خطای واقعی «reading 'title'» باشد
      const title = c.title;
      const accent = c.accent;
      const id = c.id;
      const badge = c.tag;
      const subtitle = c.subtitle;
      const description = c.description;
      const points = c.points;
      return `
      <article class="challenge challenge--${accent}">
        <div class="challenge__top">
          <span class="challenge__badge">${escapeHtml(badge)}</span>
          <span class="challenge__id">${escapeHtml(id)}</span>
        </div>
        <h3 class="challenge__title">${escapeHtml(title)}</h3>
        <p class="challenge__subtitle">${escapeHtml(subtitle)}</p>
        <p class="challenge__desc">${escapeHtml(description)}</p>
        <ul class="challenge__points">${points
          .map((p) => `<li>${escapeHtml(p)}</li>`)
          .join("")}</ul>
      </article>`;
    })
    .join("");
}

/** تأخیر مصنوعی در حالت slow */
function slowDelay() {
  if (state.bugMode !== "slow") return Promise.resolve();
  const delay = 2000 + Math.floor(Math.random() * 2000);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/* ─────────────────────────── نشت حافظه ─────────────────────────── */

function startLeak() {
  if (state.leakTimer) return;
  state.leakTimer = setInterval(() => {
    // هر ثانیه ~۵MB داده در یک آرایهٔ سراسری نگه داشته می‌شود
    state.leakSink.push(Buffer.alloc(5 * 1024 * 1024, "agate"));
    log(`[BUG] leak active heapMB=${memMB()} sinkItems=${state.leakSink.length}`);
  }, 1000);
  state.leakTimer.unref?.();
}

function stopLeak() {
  if (state.leakTimer) {
    clearInterval(state.leakTimer);
    state.leakTimer = null;
  }
  state.leakSink = [];
}

/* ─────────────────────────── مسیرها ─────────────────────────── */

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type":
      typeof body === "string" ? "text/html; charset=utf-8" : "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(payload);
}

function sendJson(res, status, data) {
  send(res, status, data);
}

/** پنل ادمین مخفی: فقط با کلید درست باز می‌شود */
async function handleAdmin(req, res, url) {
  const key = url.searchParams.get("key") ?? "";
  const expected = process.env.ADMIN_KEY;
  if (!expected || key !== expected) {
    send(res, 404, "<!doctype html><meta charset='utf-8'><p>404</p>");
    return;
  }

  const mode = url.searchParams.get("mode");
  if (mode && VALID_MODES.includes(mode)) {
    applyMode(mode);
    log(`[admin] bug mode → ${mode}`);
    res.writeHead(302, { Location: `/__agate-admin?key=${encodeURIComponent(key)}` });
    res.end();
    return;
  }

  const html = `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agate Admin — کنترل حالت باگ</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body class="admin">
  <main class="admin__panel">
    <h1>پنل کنترل آزمایش <span class="admin__dot"></span></h1>
    <p class="admin__lead">حالت فعال: <strong data-bug-mode>${escapeHtml(state.bugMode)}</strong></p>
    <div class="admin__grid">
      ${VALID_MODES.map(
        (m) => `<a class="admin__btn admin__btn--${m}${m === state.bugMode ? " is-active" : ""}" href="/__agate-admin?key=${encodeURIComponent(key)}&mode=${m}">${m}</a>`,
      ).join("")}
    </div>
    <pre class="admin__log">${escapeHtml(
      [
        `uptime: ${uptimeSec()}s`,
        `heapMB: ${memMB()}`,
        `leakItems: ${state.leakSink.length}`,
        "",
        "حالت leak : هر ثانیه ~۵MB در حافظه نگه داشته می‌شود",
        "حالت slow : تأخیر ۲ تا ۴ ثانیه در / و /api/*",
        "حالت error500 : استثنای واقعی در / و /api/challenges (‎/health سالم می‌ماند)",
      ].join("\n"),
    )}</pre>
    <a class="admin__back" href="/">← بازگشت به صفحهٔ اصلی</a>
  </main>
  <script>
    setInterval(async () => {
      try {
        const r = await fetch('/health');
        const d = await r.json();
        document.querySelector('[data-bug-mode]').textContent = d.bugMode;
      } catch {}
    }, 3000);
  </script>
</body>
</html>`;
  send(res, 200, html);
}

function applyMode(mode) {
  state.bugMode = mode;
  if (mode === "leak") startLeak();
  else stopLeak();
}

/** صفحهٔ خطای داخلی (شکل واقعی یک ۵۰۰) */
function errorPage(err) {
  const stack = String(err?.stack ?? err).split("\n").slice(0, 8).join("\n");
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>خطای داخلی</title><link rel="stylesheet" href="/styles.css"></head>
<body class="admin"><main class="admin__panel"><h1>۵۰۰ — خطای داخلی سرور</h1>
<pre class="admin__log">${escapeHtml(stack)}</pre>
<p class="admin__lead">مسیر <code>/health</code> همچنان ۲۰۰ برمی‌گرداند.</p></main></body></html>`;
}

/** صفحهٔ اصلی */
async function handleHome(req, res) {
  await slowDelay();
  const started = Date.now();

  try {
    const cards = buildChallengeCards();
    const html = `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agate Co. — دستیار DevOps و SRE برای لیارا</title>
<meta name="description" content="Agate Co. — عامل DevOps و SRE مبتنی بر MCP برای لیارا: استقرار، تشخیص رخداد، راهکار با تأیید انسانی و تأیید پس از اصلاح.">
<link rel="preconnect" href="https://cdn.jsdelivr.net">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/rastikerdar/vazirmatn@v33.003/Vazirmatn-font-face.css">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<a class="skip-link" href="#main">پرش به محتوای اصلی</a>
<div class="bg-grid" aria-hidden="true"></div>

<header class="topbar">
  <div class="wrap topbar__inner">
    <a class="brand" href="/">
      <span class="brand__mark" aria-hidden="true">
        <svg viewBox="0 0 32 32" width="28" height="28"><path d="M16 2 30 10v12L16 30 2 22V10z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M16 8.5 23.5 13v6L16 23.5 8.5 19v-6z" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".65"/><circle cx="16" cy="16" r="2.4" fill="currentColor"/></svg>
      </span>
      <span class="brand__text"><strong>Agate Co.</strong><small>DevOps &amp; SRE Agent</small></span>
    </a>
    <nav class="topnav" aria-label="ناوبری اصلی">
      <a href="#challenges">چالش‌ها</a>
      <a href="#how">جریان کار</a>
      <a href="#status">وضعیت زنده</a>
    </nav>
    <div class="pill pill--live" id="live-pill" role="status" aria-live="polite">
      <span class="pill__dot" aria-hidden="true"></span><span data-health>در حال بررسی…</span>
    </div>
  </div>
</header>

<main id="main">
  <section class="hero">
    <div class="wrap hero__inner">
      <div class="hero__copy">
        <p class="eyebrow"><span class="eyebrow__tag">Starcoach Agentic AI Hackathon</span> چالش لیارا</p>
        <h1 class="hero__title">عامل DevOps و SRE<br><span class="grad">برای لیارا</span></h1>
        <p class="hero__lead">
          از یک درخواست ساده تا استقرار واقعی، تحلیل ریشه‌ای رخداد، پیشنهاد راهکار با <strong>تأیید اجباری انسان</strong>
          و در نهایت اثبات اینکه مشکل واقعاً برطرف شده است.
        </p>
        <div class="hero__actions">
          <a class="btn btn--primary" href="#status">مشاهدهٔ وضعیت زنده</a>
          <a class="btn btn--ghost" href="https://github.com/thecapitalland/Hackaton-Liara" target="_blank" rel="noopener">مخزن کد</a>
        </div>
        <dl class="facts">
          <div><dt>ابزارهای MCP</dt><dd>خواندن، تأیید و اجرا</dd></div>
          <div><dt>رتبه‌بندی علت</dt><dd>۳ علت با شواهد</dd></div>
          <div><dt>دروازهٔ تأیید</dt><dd>هر نوشتنی، تأیید انسانی</dd></div>
        </dl>
      </div>

      <div class="hero__panel" aria-label="نمونهٔ خروجی ابزار">
        <div class="term">
          <div class="term__bar"><span class="term__dots"><i></i><i></i><i></i></span><span class="term__title">نمونهٔ نمایشی خروجی · deploy_project</span></div>
          <pre class="term__body"><code><span class="t-dim">⏳</span> بسته‌بندی سورس...
<span class="t-ok">✅</span> آپلود انجام شد (2.1MB)
<span class="t-dim">⏳</span> ساخت (build)... آخرین لاگ: npm install done
<span class="t-ok">✅</span> انتشار موفق — release: <span class="t-id">abc123</span>
<span class="t-ok">✅</span> سلامت: 200 در 180ms
<span class="t-net">🌐</span> آدرس زنده: <span class="t-url">https://agate-liara.liara.run</span></code></pre>
        </div>
        <p class="hero__note">این خروجی صرفاً نمونه است؛ استقرار واقعی به اتصال حساب و تأیید شما نیاز دارد.</p>
      </div>
    </div>
  </section>

  <section class="section" id="how">
    <div class="wrap">
      <h2 class="section__title">جریان کار <span class="section__hint">از درخواست تا اثبات اصلاح</span></h2>
      <ol class="steps">
        <li class="step"><span class="step__n">۱</span><h3>تشخیص</h3><p>استک پروژه، پورت و متغیرهای لازم تشخیص داده می‌شود.</p><code class="step__cmd">detect_stack()</code></li>
        <li class="step"><span class="step__n">۲</span><h3>استقرار</h3><p>بسته‌بندی امن، آپلود، انتشار و پیگیری بیلد تا آدرس زنده.</p><code class="step__cmd">deploy_project()</code></li>
        <li class="step"><span class="step__n">۳</span><h3>تحلیل رخداد</h3><p>لاگ، متریک، رویداد و پروب؛ سپس ۳ علت رتبه‌بندی‌شده با شواهد.</p><code class="step__cmd">diagnose()</code></li>
        <li class="step"><span class="step__n">۴</span><h3>تأیید و اصلاح</h3><p>راهکار با ریسک و اثر نمایش داده می‌شود؛ تا تأیید شما هیچ تغییری اعمال نمی‌شود.</p><code class="step__cmd">apply_fix()</code></li>
        <li class="step"><span class="step__n">۵</span><h3>اثبات اصلاح</h3><p>مقایسهٔ قبل/بعد و تکرار پروب؛ نتیجه تأیید یا رد می‌شود.</p><code class="step__cmd">verify_fix()</code></li>
      </ol>
    </div>
  </section>

  <section class="section section--alt" id="challenges">
    <div class="wrap">
      <h2 class="section__title">سه چالش هکاتون</h2>
      <p class="section__lead">این سایت سه چالش را معرفی می‌کند. طبق قواعد مسابقه، فقط چالش لیارا پیاده‌سازی شده و دو چالش دیگر محتوای نمایشی هستند.</p>
      <div class="challenges">${cards}</div>
    </div>
  </section>

  <section class="section" id="status">
    <div class="wrap status-grid">
      <div>
        <h2 class="section__title">وضعیت زندهٔ سرویس</h2>
        <p class="section__lead">داده‌های زیر مستقیماً از همین سرویس و مسیر <code>/health</code> خوانده می‌شوند. پاسخ سالم این مسیر به‌تنهایی سالم‌بودن همهٔ صفحات را ثابت نمی‌کند.</p>
        <div class="status-cards">
          <div class="status-card"><span class="status-card__k">وضعیت</span><strong data-s="status">—</strong></div>
          <div class="status-card"><span class="status-card__k">حالت آزمایش</span><strong data-s="bugMode">—</strong></div>
          <div class="status-card"><span class="status-card__k">مدت فعالیت</span><strong data-s="uptime">—</strong></div>
          <div class="status-card"><span class="status-card__k">حافظهٔ heap</span><strong data-s="memMB">—</strong></div>
        </div>
        <p class="status-note">برای دیدن رفتار خرابی، از پنل آزمایش استفاده کنید: <code>/__agate-admin</code> (نیازمند کلید).</p>
      </div>
      <div class="code-card">
        <span class="code-card__label">GET /health</span>
        <pre><code data-s="raw">{ }</code></pre>
      </div>
    </div>
  </section>
</main>

<footer class="footer">
  <div class="wrap footer__inner">
    <p><strong>Agate Co.</strong> — ساخته‌شده برای چالش لیارا در هکاتون Starcoach Agentic AI.</p>
    <p class="footer__muted">اپ آزمایشی Agate-Liara؛ مناسب نمایش دیپلوی، رخداد و تأیید اصلاح.</p>
  </div>
</footer>

<script src="/app.js"></script>
</body>
</html>`;
  log(`GET / → 200 (${Date.now() - started}ms, mode=${state.bugMode})`);
  send(res, 200, html);
  } catch (err) {
    log(`ERROR Uncaught ${err?.name ?? "Error"}: ${err?.message ?? err}\n${err?.stack ?? ""}`);
    send(res, 500, errorPage(err));
  }
}

/* ─────────────────────────── سرور ─────────────────────────── */

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    try {
      /* health — همیشه ۲۰۰، حتی وقتی بقیهٔ مسیرها خراب‌اند */
      if (pathname === "/health") {
        sendJson(res, 200, {
          status: "ok",
          bugMode: state.bugMode,
          uptime: uptimeSec(),
          memMB: memMB(),
          extMB: extMB(),
          rssMB: rssMB(),
        });
        return;
      }

      if (pathname === "/styles.css" || pathname === "/app.js") {
        const file = path.join(here, "public", pathname.slice(1));
        const content = await readFile(file, "utf8");
        send(res, 200, content, { "Content-Type": pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' });
        return;
      }

      if (pathname === "/__agate-admin") {
        await handleAdmin(req, res, url);
        return;
      }

      if (pathname === "/api/challenges") {
        await slowDelay();
        try {
          const cards = buildChallengeCards();
          void cards;
        } catch (err) {
          log(`ERROR Uncaught ${err?.name ?? "Error"}: ${err?.message ?? err}\n${err?.stack ?? ""}`);
          sendJson(res, 500, {
            error: String(err?.message ?? err),
            type: err?.name ?? "Error",
          });
          return;
        }
        sendJson(res, 200, { challenges: CHALLENGES });
        return;
      }

      if (pathname === "/api/status") {
        sendJson(res, 200, {
          status: "ok",
          bugMode: state.bugMode,
          uptime: uptimeSec(),
          memMB: memMB(),
        });
        return;
      }

      if (pathname === "/" || pathname === "/index.html") {
        await handleHome(req, res);
        return;
      }

      send(res, 404, "<!doctype html><html lang='fa' dir='rtl'><meta charset='utf-8'><p>404 — صفحه پیدا نشد</p></html>");
    } catch (err) {
      log(`ERROR unhandled: ${err?.stack ?? err}`);
      sendJson(res, 500, { error: String(err?.message ?? err) });
    }
  });
}

export function start(port = Number(process.env.PORT ?? 3000)) {
  const server = createServer();
  server.listen(port, () => {
    log(`Agate Co. demo site روی پورت ${port} بالا آمد (mode=${state.bugMode})`);
  });
  return server;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  applyMode(state.bugMode);
  start();
}
