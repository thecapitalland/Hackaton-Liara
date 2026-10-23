<p align="center">
  <img src="docs/images/agate-liara-hero.svg" alt="Agate-Liara — MCP for Liara PaaS" width="100%">
</p>

<h1 align="center">Agate-Liara</h1>

<p align="center">
  دستیار DevOps/SRE فارسی برای لیارا — تشخیص با شواهد، تأیید انسانی، رفع قابل‌بازگشت و verify مستقل.
</p>

<p align="center">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white">
  <img alt="Node" src="https://img.shields.io/badge/Node-%E2%89%A520-339933?logo=nodedotjs&logoColor=white">
  <img alt="MCP stdio" src="https://img.shields.io/badge/MCP-stdio-6E56CF">
  <img alt="Tests" src="https://img.shields.io/badge/tests-94%2F94-brightgreen">
  <img alt="Approval policy" src="https://img.shields.io/badge/approval-strict-0B7285">
  <img alt="Liara" src="https://img.shields.io/badge/Liara-PaaS-6C5CE7">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue">
</p>

> **وضعیت زنده · ۲۰۲۶-۱۰-۲۳:** اپ `agate-liara` روی `small-g2` فعال است؛ ۱۰ release آخر `READY` هستند؛ `/` و `/health` هر دو HTTP 200 برمی‌گردانند. اتصال **native MCP** در OpenCode 2.1.2 برقرار و با فراخوانی مستقیم ابزارها اثبات شد. تمرین زندهٔ rollback عمداً به زمان ضبط ویدیو موکول شده و هیچ mutationای در این بررسی انجام نشد.

## معرفی کوتاه

**Agate-Liara** یک سرور MCP با انتقال `stdio` است که یک ایجنت کدنویس را به لیارا وصل می‌کند: وضعیت اپ، لاگ، متریک، رویداد، release، دامنه و پروب HTTP را می‌خواند؛ رخداد را با شواهد محدود به پنجرهٔ ۱۰ دقیقه‌ای تشخیص می‌دهد؛ و فقط از مسیر تأیید انسانی، اقدام درمانیِ قابل‌بازگشت اجرا می‌کند. سرور بدون دیتابیس، LangGraph یا کنسول مدیریتی است و state حساس را محلی و خارج از ورودی LLM نگه می‌دارد.

سه ویژگی که آن را از «چت‌بات DevOps» جدا می‌کند:

- **تشخیص env-blind:** مقدار env و فهرست کلیدهای env و بدنهٔ `/health` وارد تشخیص یا پرامپت LLM نمی‌شوند.
- **تأیید مقید به هش:** هر نوشتن از یک نقطهٔ تصمیم‌گیری (`decideApproval`) عبور می‌کند؛ approval به پارامترهای دقیق، ۱۰ دقیقه و یک‌بار مصرف مقید است.
- **verify قبل از ادعای موفقیت:** بعد از اقدام، پروب و متریک دوباره خوانده می‌شوند؛ نبود شاهد، موفقیت حساب نمی‌شود.

## وضعیت زنده (آخرین مشاهده)

| مورد | آخرین مشاهده | یادداشت |
|---|---|---|
| اپ `agate-liara` | `ACTIVE` · پلن `small-g2` · scale `1` | بدون custom domain در پاسخ domains؛ دامنهٔ پیش‌فرض `agate-liara.liara.run` مستقل probe شد |
| Releaseها | ۱۰ مورد آخر: `READY` | جدیدترین در فهرست: `6adaf85c72aa39a87a8c3756` |
| صفحهٔ اصلی `/` | HTTP 200 · p50 ≈ 782ms | یک نمونهٔ واقعی؛ latency بین اجراها تغییر می‌کند |
| سلامت `/health` | HTTP 200 · p50 ≈ 607ms | health تنها منبع تشخیص نیست؛ صفحهٔ `/` هم probe می‌شود |
| env اپ | ۴ کلید | **هیچ مقدار یا نام کلید envی در README/LLM گزارش نمی‌شود** |
| Native MCP | `✓ agate-liara connected` | OpenCode 2.1.2 · `codemode:false` · ابزارها روی لیست بومی provider |
| Live rollback drill | **NOT_RUN (تعویق)** | برای ضبط ویدیو نگه داشته شد؛ هیچ restart/rollback/env mutation انجام نشد |

## نتایج واقعی تست‌ها

آخرین اجرای کامل: **۲۰۲۶-۱۰-۲۳**. ستون «حوزه» مشخص می‌کند شاهد، تست قطعی/unit است یا خواندن واقعی و read-only. هیچ مورد `NOT_RUN` را PASS حساب نکرده‌ایم.

| سناریو | نتیجه | شاهد و محدوده |
|---|---|---|
| **leak** | **PASS** | `npm run demo:test` → حالت leak واقعاً حافظهٔ نگه‌داشته‌شده را بالا می‌برد؛ `npm test` → «تشخیص نشت حافظه با سری صعودی و لاگ heap» |
| **slow** | **PASS** | `npm run demo:test` → حالت slow پاسخ صفحهٔ اصلی را حدود ۳.۷ ثانیه تأخیر می‌دهد؛ `npm test` → «تشخیص کندی پاسخ وقتی CPU نرمال است» |
| **blind** | **PASS (unit)** | `BUG_MODE` و مقدار حالت از پرامپت LLM حذف می‌شوند؛ پرامپت فقط اجزای مجاز را دارد؛ `diagnose` مقدار/فهرست env و بدنهٔ `/health` را وارد تشخیص نمی‌کند |
| **watch** | **PASS (unit) + live read-only** | ۹ نمونه از ۳ مسیر، آستانه‌های ۵٪/۱۵۰۰ms، cooldown و snapshot سالم env تست شده‌اند؛ اجرای تاریخی `npm run watch -- --once` روی اپ واقعی healthy و بدون incident بود |
| **baseline rollback** | **PASS (unit)** | baseline سالم منبع سوم rollback است؛ diff فقط کلیدهای تغییرکرده را برمی‌گرداند؛ فایل در سیستم‌های پشتیبان‌شده با mode `0600` و بدون ارسال مقدار به LLM ذخیره می‌شود؛ بدون baseline کارت ۳ گزینه‌ای باز می‌شود |
| **live env rollback** | **NOT_RUN** | عمداً به ضبط ویدیو موکول شد؛ `APPROVAL_POLICY=strict` و هیچ mutationای انجام نشد |

### Quality gate

| بررسی | نتیجه | شاهد |
|---|---|---|
| `npm run typecheck` | **PASS** | `tsc -p tsconfig.json --noEmit` |
| `npm test` | **PASS — 94/94** | 0 failed · ~2.76s · شامل approval، env-history، incident-window، remedy-selection، rollback-plan، watch و server |
| `npm run build` | **PASS** | `dist` بازسازی شد |
| `npm run smoke -- --offline` | **PASS** | stdio handshake واقعی، کشف **۳۳ ابزار**، ping |
| `npm run smoke` | **PASS** | live list + HTTP probe، فقط read-only |
| `npm run demo:test` | **PASS — 7/7** | health، slow، error500، leak، admin auth |
| `npm run secret-scan` | **PASS** | **۷۹ فایل** قابل commit؛ کلید تنظیم‌شده/private-key marker یافت نشد (detector عمومی نیست) |
| `node dist/index.js --help` | **PASS** | command/args/cwd، متغیرها و خلاصهٔ اقدام قابل‌بازگشت |
| `git diff --check` | **PASS** | فقط هشدارهای line-ending ویندوز |

## چرا قابل اعتماد است؟

### ۱) تشخیص env-blind است

`diagnose` هیچ **مقدار env** و هیچ **فهرست کلید env** را از API نمی‌خواند. ورودی تشخیص فقط این‌هاست:

- لاگ‌ها و رویدادهای پنجرهٔ ۱۰ دقیقه‌ای حول `incidentAt`
- متریک CPU/حافظه (خام و بدون حدس واحد)
- status/latency مسیر `/` و `/health` — بدنهٔ `/health` parse نمی‌شود
- متادیتای audit/release برای «آیا تغییر env دقیقی وجود دارد؟» — فقط وجود/زمان، نه مقدار یا کلید

پرامپت LLM از همین ورودی ساخته می‌شود و `stripBugMode` هر اشارهٔ مستقیم به `BUG_MODE`/`bugMode` را حذف می‌کند. اگر شاهد کافی نباشد، پاسخ `inconclusive` است و LLM بی‌دلیل صدا زده نمی‌شود.

### ۲) سیاست تأیید یک نقطهٔ واحد دارد

تنها تابع تصمیم‌گیری [`decideApproval`](src/approval.ts) است. هر اقدام یک `riskLevel` از `low` / `medium` / `high` دارد:

| سیاست | رفتار |
|---|---|
| `strict` (پیش‌فرض) | **همهٔ** اقدام‌های نوشتنی تأیید انسانی می‌خواهند |
| `balanced` | فقط `low` خودکار است (`restart`، SSL و خواندن‌ها). `rollback_last_env_change` اکنون **`medium`** است و تأیید می‌خواهد؛ `liara_set_env`، deploy و resize هم تأیید می‌خواهند |
| `auto` | `low`/`medium` خودکار؛ `high` همچنان تأیید می‌خواهد |

اقدام‌های هزینه‌دار/پرخطر — ساخت اپ/شبکه، resize، scale و خاموش‌کردن سرویس — در **همهٔ** سیاست‌ها `high` هستند و همیشه تأیید می‌خواهند. approval به هش پارامترها مقید است، ۱۰ دقیقه اعتبار دارد، یک‌بار مصرف می‌شود و بعد از تغییر پارامترها باطل می‌شود. **هیچ fallback خودکار به restart وجود ندارد**: اگر baseline/journal برای rollback دقیق کافی نباشد، به‌جای تغییر کورکورانه، کارت ۳ گزینه‌ای بازیابی env نمایش داده می‌شود.

### ۳) Audit و state محلی قابل ردیابی‌اند

- هر تصمیم در `.agate/audit.jsonl` ثبت می‌شود: `pending`، `approved`، `auto:balanced` یا `not-required`.
- `.agate/env-history-<app>.json` فقط تغییرهای env انجام‌شده از همین MCP را با before/after واقعی نگه می‌دارد.
- `.agate/env-baseline-<app>.json` snapshot سالم env است؛ فقط وقتی پروب سالم است ثبت می‌شود.
- این فایل‌ها gitignored هستند، در سیستم‌هایی که پشتیبانی می‌شود با mode `0600` نوشته می‌شوند، در ورودی LLM قرار نمی‌گیرند و خروجی ابزارها فقط مقدارهای ماسک‌شده را نشان می‌دهد.
- `.env`، `.agate`، `node_modules` و `dist` هرگز commit نمی‌شوند.

## چرخهٔ تشخیص تا رفع

```mermaid
flowchart TD
  W["watch_app / npm run watch"] --> P["۹ پروب از ۳ مسیر + متریک + رویدادها"]
  P --> H{"ناسالم؟"}
  H -- "نه" --> W
  H -- "بله" --> D["diagnose با همان ۹ نمونه"]
  D --> R["حداکثر ۳ علت رتبه‌بندی‌شده"]
  R --> S["انتخاب راهکار: restart یا rollback_last_env_change"]
  S --> A{"APPROVAL_POLICY"}
  A -- "strict یا ریسک medium" --> C["کارت تأیید انسانی"]
  A -- "balanced + low" --> X["اجرای خودکار low"]
  A -- "auto + low/medium" --> X
  C --> E["اجرای یک‌باره با approvalId مقید به هش"]
  X --> E
  E --> V["verify_fix: probe + متریک + baseline"]
  V -- "سالم" --> OK["گزارش before/after + audit"]
  V -- "ناسالم" --> STOP["توقف؛ بدون retry کورکورانه"]
  STOP --> CARD["در نبود baseline: کارت ۳ گزینه‌ای بازیابی env"]
```

## اتصال Native MCP در OpenCode

فایل [`opencode.json`](opencode.json) در ریشهٔ مخزن، سرور را به‌صورت local و با `codemode:false` معرفی می‌کند. این یعنی ابزارها به‌جای wrapper کد، روی **لیست ابزارهای بومی provider** قرار می‌گیرند:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "agate-liara": {
        "type": "local",
        "command": ["node", "dist/index.js"],
        "cwd": ".",
        "environment": {
          "AGATE_ALLOWED_APPS": "agate-liara",
          "APPROVAL_POLICY": "strict"
        },
        "codemode": false
      }
    }
  }
}
```

پس از `npm run build` و `opencode reload`:

```text
$ opencode mcp list
✓ agate-liara  connected
```

### اثبات فراخوانی از ابزارهای خود OpenCode

| فراخوانی | نتیجهٔ مشاهده‌شده |
|---|---|
| `agate-liara_ping` | سرور فعال؛ توکن تنظیم شده؛ اپ مجاز `agate-liara`؛ LLM فعال |
| `agate-liara_liara_list_apps` | `agate-liara — ACTIVE · small-g2` |
| `agate-liara_liara_status` | `ACTIVE` · `small-g2` · scale `1` · ۴ کلید env |
| `agate-liara_liara_releases` | ۱۰ release آخر `READY` |
| `agate-liara_http_probe("/")` | HTTP 200 · 782ms |
| `agate-liara_http_probe("/health")` | HTTP 200 · 607ms |

نمونهٔ خروجی واقعی:

```text
✅ سرور Agate-Liara فعال است.
🔑 توکن لیارا: تنظیم شده
📦 اپ‌های مجاز: agate-liara
🤖 LLM: فعال (gpt-5-mini)
🌐 بیس API: https://api.iran.liara.ir
```

```text
📦 اپ‌های حساب لیارا
• agate-liara — وضعیت: ACTIVE | پلن: small-g2
```

این فراخوانی‌ها مستقیماً از ابزارهای native خود OpenCode انجام شدند، نه از `scripts/mcp-call.ts`. تصویر خلاصهٔ شاهد:

<p align="center">
  <img src="docs/images/native-mcp-proof.svg" alt="Native MCP proof in OpenCode" width="100%">
</p>

> برای اتصال در محیط‌های دیگر، نمونه‌های VS Code، Cursor و Codex در [`examples/`](examples/) هستند. `cwd` را ریشهٔ همین مخزن بگذارید تا `.env` و `.agate` مشترک بمانند.

## شروع سریع

نیازمندی: Node ≥20 و npm. دستورها را در ریشهٔ همین مخزن اجرا کنید:

```powershell
npm ci
# اگر .env وجود ندارد:
Copy-Item .env.example .env
# توکن و تنظیمات اختیاری را فقط داخل .env وارد کنید.
npm run build
npm test
npm run demo:test
npm run smoke
# بررسی مستقل از شبکه:
npm run smoke -- --offline
npm run preflight
```

از بازنویسی `.env` موجود خودداری کنید. نبودن توکن مانع بالا آمدن MCP نیست؛ ابزارهای لیارا پیام فارسی راهنما می‌دهند. خروجی پروتکل روی **stdout** و پیام راه‌اندازی روی **stderr** است.

## معماری

```mermaid
flowchart LR
  IDE["OpenCode / IDE"] <-->|MCP stdio| MCP["Agate-Liara"]
  MCP --> API["Liara PaaS API"]
  MCP --> DNS["Liara DNS API: read-only preflight"]
  MCP -. optional ranking .-> LLM["OpenAI-compatible LLM"]
  MCP --> PROBE["HTTPS probe"]
  MCP --> STATE[".agate: approvals / audit / journal / baseline"]
  HUMAN["Human"] -->|elicitation or CLI| MCP
```

## ابزارها (۳۳ ابزار)

| سطح | ابزارها |
|---|---|
| A: خواندنی | `ping`, `liara_status`, `liara_list_apps`, `liara_logs`, `liara_metrics`, `liara_events`, `liara_plans`, `liara_releases`, `http_probe`, `audit_tail`, `liara_plan_price`, `liara_release_status` |
| B: نوشتنی (مطابق `APPROVAL_POLICY`) | `liara_create_app`, `liara_deploy`, `liara_set_env`, `rollback_last_env_change`, `liara_restart`, `liara_scale`, `liara_resize`, `liara_add_domain`, `liara_enable_ssl`, `propose_action`, `execute_action` |
| ترکیبی | `deploy_project`, `diagnose`, `apply_fix`, `verify_fix`, `connect_domain`, `watch_after_deploy`, `watch_app` |
| C: راهنما | `guide_domain_registration`, `guide_rollback`, `guide_github_deploy` |

`http_probe(target, path="/health", count=3)` فقط HTTPS دامنه‌های متصل به اپ‌های مجاز را می‌پذیرد و redirect را دنبال نمی‌کند. `diagnose` علاوه بر متریک و لاگ، صفحهٔ `/` را می‌سنجد تا سلامت `/health` خطای صفحهٔ اصلی را پنهان نکند. بازهٔ شواهد و رویدادها **۱۰ دقیقه حول زمان رخداد** است و رویداد قدیمی‌تر یا بدون timestamp معتبر کنار گذاشته می‌شود. `verify_fix` نبودن لاگ یا baseline معتبر را موفقیت گزارش نمی‌کند.

## پایش مداوم

`watch_app` و `npm run watch` هر `WATCH_INTERVAL_SEC` (پیش‌فرض ۶۰) ثانیه یک چرخه اجرا می‌کنند:

1. `/`، `/api/challenges` و `/api/status` را هر کدام سه بار probe می‌کنند (۹ نمونه).
2. خلاصهٔ متریک و رویدادها را می‌خوانند.
3. اگر نرخ 500 اکیداً بالای ۵٪، p50 یک مسیر بالای ۱۵۰۰ms، یا رویداد **جدید** OOM/ری‌استارت/کرش دیده شود، `diagnose` را با **همان ۹ نمونه و همان رویدادهای چرخه** اجرا می‌کنند.
4. رخداد را در `.agate/audit.jsonl` با `tool: "watch_incident"` ثبت می‌کنند.
5. تا `WATCH_COOLDOWN_SEC` (پیش‌فرض ۳۰۰) از تکرار همان هشدار جلوگیری می‌کنند.

```powershell
npm run watch
npm run watch -- --once
npm run watch -- --app agate-liara
```

**انتخاب اقدام درمانی:** LLM فقط `restart` و — فقط وقتی یک تغییر env دقیق و قابل‌بازگشت در ۱۰ دقیقهٔ قبل در journal/baseline ثبت شده باشد — `rollback_last_env_change` را می‌بیند. انتخاب خارج از این فهرست نادیده گرفته می‌شود. `rollback_last_env_change` ریسک `medium` دارد و در `strict` و `balanced` نیازمند تأیید است. اگر مقدار فعلی با مقدار `after` ثبت‌شده فرق کند یا تغییر جدیدتر باشد، rollback انجام نمی‌شود و `restart` پیشنهاد می‌شود.

**محدودیت پایش:** خلاصهٔ متریک در دسترس است ولی واحد CPU/حافظه تأیید نشده و عدد خام گزارش می‌شود. سری زمانی و لاگ ممکن است 503 یا ناسازگار باشند؛ watch با probe و رویدادها ادامه می‌دهد و محدودیت را در گزارش می‌آورد. journal فقط تغییرهایی را می‌داند که از همین MCP انجام شده‌اند.

## سایت دمو

```powershell
node --env-file=.env demo-site/server.mjs
```

صفحهٔ اصلی: `http://localhost:3000/` · پنل آزمایش: `/__agate-admin?key=<ADMIN_KEY>` · سلامت: `/health`.

سه حالت خراب‌سازی عمدی: افزایش Buffer حدود ۵MB/ثانیه، تأخیر ۲–۴ ثانیه و خطای واقعی `TypeError`. Buffer بیرون heap است؛ `extMB` و `rssMB` هم گزارش می‌شوند. این اپ فقط برای محیط دورریختنی است؛ حالت leak را بی‌مراقبت رها نکنید. برای انتشار، ایجنت را به `deploy_project(path="./demo-site", app="agate-liara")` هدایت کنید؛ **ریشهٔ MCP را به‌عنوان وب‌سایت دیپلوی نکنید**.

## محدودیت‌های API لیارا

| محدودیت | اثر | رفتار جایگزین |
|---|---|---|
| rollback endpoint عمومی ندارد | برگشت کد/سورس از API ممکن نیست | `rollback_last_env_change` فقط env را از journal/baseline محلی برمی‌گرداند؛ برای کد، release قبلی را با تأیید تازه دوباره deploy کنید |
| log streaming ندارد | tail زندهٔ لاگ ممکن نیست | polling با بازهٔ محدود و پنجرهٔ ۱۰ دقیقه‌ای |
| endpoint مستقل plans ندارد | catalog از مسیر استاندارد خوانده نمی‌شود | `GET /v1/me` و `plans.projects` / `projectBundlePlans` |
| health-check API ندارد | سلامت سرویس از API قابل تأیید نیست | HTTP probe مستقل روی `/` و `/health`؛ بدنهٔ health parse نمی‌شود |
| ثبت/خرید دامنه ندارد | دامنهٔ جدید خودکار ثبت نمی‌شود | ثبت دستی در IRNIC؛ ابزار فقط اتصال، DNS check و SSL را انجام می‌دهد |
| اتصال مستقیم GitHub ندارد | deploy از repo به‌صورت native نیست | GitHub Action آماده + Liara CLI (`guide_github_deploy`) |
| DNS zone/record mutation پیاده نشده | رکوردها خودکار ساخته نمی‌شوند | پاسخ DNS را بخوانید و رکوردها را دستی تنظیم کنید |
| `bundlePlanID` بین GET و POST ناسازگار است | برخی پلن‌های `available` در POST رد می‌شوند | فیلتر strict کاتالوگ، quote تازه، بدون حدس/جایگزینی خودکار؛ خطاها در `LIARA_API.md` |
| واحد CPU/RAM در متریک تأیید نشده | تصمیم خودکار resize خطرناک است | عدد خام گزارش می‌شود؛ ارتقای پلن فقط با تأیید انسان |
| `update-envs` کل فهرست را جایگزین می‌کند | نوشتن ساده می‌تواند کلیدها را حذف کند | read/merge/write؛ فقط کلیدهای تغییرکرده در journal ثبت می‌شوند |
| default domain در domains list دیده نمی‌شود | ممکن است custom domain خالی به‌نظر برسد | دامنهٔ پیش‌فرض جداگانه probe می‌شود؛ `liara_status` فقط دامنه‌های ثبت‌شده را نشان می‌دهد |
| state محلی single-process است | multi-executor هم‌زمان پشتیبانی نمی‌شود | `.agate` را محدود نگه دارید؛ برای محیط تولیدی locking/encryption لازم است |

> این جدول جایگزین endpoint ساختگی نیست. هر اختلاف واقعی API در [`docs/LIARA_API.md`](docs/LIARA_API.md) ثبت می‌شود.

## مستندات

- [شواهد تست و تأیید](docs/TEST_EVIDENCE.md)
- [رجیستری API لیارا و اختلاف‌های واقعی](docs/LIARA_API.md)
- [محدودیت‌ها و وضعیت صادقانه](docs/LIMITATIONS.md)
- [پیشرفت و تاریخ تصمیم‌ها](PROGRESS.md)
- [سناریوی دمو](DEMO_SCRIPT.md)
- [درس‌آموخته‌ها](LESSONS.md)
- [نمونه‌های اتصال IDE](examples/)

## مجوز

MIT — مطابق `package.json`. سایت دمو عمداً قابل خراب‌کردن است و برای محیط تولیدی طراحی نشده.
