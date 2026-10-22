# LESSONS — Agate-Liara

## 2026-10-22 — «تایم‌اوت build» برای release `6ada364eb3b5ca83e1f16704` واقعی نبود

### مشاهدهٔ اولیه
`waitForRelease` بعد از ۱۰ دقیقه با `status:"timeout"`, `stage:"build"`, `ok:false` برگشت و تصور شد بیلد در `npm install` گیر کرده است.

### واقعیت (بررسی فقط‌خواندنی)
- `GET /v1/releases/6ada364eb3b5ca83e1f16704` → `{ release: { state: "READY" } }`
- `GET /v1/projects/agate-liara` → `isDeployed: true`, `status: ACTIVE`
- `GET https://agate-liara.liara.run/health` → **200** با `{"status":"ok","bugMode":"off","uptime":…}`
- صفحهٔ اصلی → **200**، ۱۰٬۳۶۲ بایت، برند Agate موجود.
- یعنی استقرار با موفقیت انجام شده بود و فقط کلاینت ما موفقیت را تشخیص نداده بود.

### تایم‌لاین واقعی بیلد (از build logs)
| زمان (UTC) | رویداد |
|---|---|
| 16:14:06.843 | `Fetching the source code: 0%` |
| 16:14:06.858 | `Fetching the source code: 100%` |
| 16:14:06.924 | `Pulling the base images...` → `All base images are already pulled` |
| 16:14:07.093 | `Preparing the build environment...` |
| 16:14:07.469 | `FROM …/node-platform:…node22`، سپس ۱۷ build trigger و چند `Using cache` |
| 16:14:09.130 | `Using Liara mirror to install packages.` |
| 16:14:09.185 | `Running npm install...` |
| **16:14:10.876** | **`up to date in 1s`** — `npm install` تمام شد؛ گیر نکرد |
| 16:14:18.611 | `Configuring timezone: Asia/Tehran` |
| 16:14:19.803 | `Successfully built a6d99744fe79` |
| 16:14:19.854 | `Successfully tagged apps/…:1uuhrjkjym59` |
| 16:14:21→31.481 | `Pushing... 0% → 100% Total size: 1.56GB` |

بنابراین بیلد در حدود **۲۵ ثانیه** تمام شد، نه ۱۰ دقیقه.

### علت ریشه‌ای
1. **شکل پاسخ تودرتو:** `GET /v1/releases/{id}` وضعیت را در `data.release.state` برمی‌گرداند، اما `releaseState()` فقط `data.status/state` را می‌خواند. نتیجه: `status:"unknown"` تا ابد و تایم‌اوت ۱۰دقیقه‌ای کلاینت.
2. **لاگ‌های صفحه‌بندی‌شده:** `GET /v2/releases/{id}/build-logs` بدون پارامتر، فقط **۲۰ خط اول** را می‌دهد و آخرین خط همان `Running npm install...` است. با `since=2026-10-22T16:14:09.185Z` خطوط بعدی (از جمله `up to date in 1s` و `Successfully built`) دیده می‌شوند. این باعث شد تیل لاگ هم «گیرکرده» به نظر برسد.

### اصلاح انجام‌شده
- `src/liara/release.ts`: تابع `unwrapRelease()` هر دو شکل تودرتو (`{release:{state}}`) و مسطح را یکسان می‌کند.
- `src/tools/composite.ts` و `src/tools/write.ts` از آن استفاده می‌کنند؛ `liara_release_status` حالا `READY` را نشان می‌دهد.
- تست رگرسیون: «وضعیت release تودرتو (`release.state`) به‌درستی خوانده می‌شود». مجموع تست‌ها: **۴۵/۴۵ PASS**.

### بستهٔ آپلودشده (حقیقت)
- فقط `demo-site` بود، نه کل ریپو: **۵ فایل، ۱۱٬۸۴۳ بایت (۱۱٫۶KB)**، SHA-256 `30dab33e…c6ebf2`.
- فایل‌ها: `liara.json`, `package.json`, `public/app.js`, `public/styles.css`, `server.mjs`.
- `package.json` همان دموست: **هیچ dependency و devDependency ندارد**؛ `test.mjs` هم عمداً حذف شده بود.
- **`package-lock.json` داخل بسته نبود** (و در `demo-site` هم وجود ندارد). `package-lock.json` و `node_modules` ریشهٔ ریپو آپلود نشده‌اند.
- وابستگی‌های ریشهٔ ریپو (خارج از بسته): runtime = `@modelcontextprotocol/sdk`, `dotenv`, `ignore`, `tar`, `zod`; dev = `@types/node`, `tsx`, `typescript`.

### توصیه‌ها برای release بعدی (در صورت نیاز)
1. **فقط `demo-site`** را آپلود کنید؛ همان ۵ فایل کافی است و کل ریپو هرگز نباید آپلود شود.
2. یک **`demo-site/package-lock.json`** با `npm install --package-lock-only --omit=dev` بسازید و داخل بسته بگذارید تا نصب قطعی/سریع باشد. (چون دمو وابستگی ندارد، محتوای lockfile تقریباً خالی است و علت تایم‌اوت نبود.)
3. **فقط وابستگی‌های اجرایی** در `demo-site/package.json` بمانند؛ devDependencies و ابزار تست را از بستهٔ اجرا جدا نگه دارید.
4. اگر پلتفرم امکان کنترل دستور نصب را می‌دهد، `npm ci --omit=dev` (یا `NODE_ENV=production` + `npm install --omit=dev`) استفاده شود. `npm install` فعلی با صفر وابستگی در ۱ ثانیه تمام شد، بنابراین **علت تایم‌اوت نصب نبود**.
5. قبل از هر retry، `state` انتشار و `/health` را چک کنید؛ «تایم‌اوت کلاینت» مساوی «شکست بیلد» نیست.

## 2026-10-22 — خطای LLM، محدودیت متریک سری‌زمانی و لاگ runtime

### LLM: `temperature: 0` پشتیبانی نمی‌شود
- درخواست `gpt-5-mini` با `temperature: 0` پاسخ **400** داد:
  `Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported.`
- نتیجه: `diagnose` بی‌صدا به fallback قانون‌محور می‌رفت و شرط «تحلیل باید با LLM باشد» برقرار نمی‌شد.
- اصلاح: حذف کامل پارامتر `temperature` از `src/diagnose/llm.ts`؛ اکنون درخواست **200** است و `diagnose` مقدار `analysisSource:"llm"`، `llmUsed:true` و `llmModel:"gpt-5-mini"` برمی‌گرداند.

### متریک CPU/حافظه: `since` باید epoch-ms باشد، اما سری‌زمانی 503 است
- `GET /v1/projects/{app}/metrics/cpu|memory?since=30` (دقیقه) پاسخ **428** داد:
  `The maximum allowed value for since is 7 days.`
- `since` به‌صورت ISO رد می‌شود (`"since" must be a number`). با epoch-ms در بازهٔ ۵ دقیقه تا ۶ روز، هر دو endpoint **503 Service Unavailable** برگرداندند.
- `GET /v1/projects/{app}/metrics/summary` کار می‌کند و یک نقطهٔ لحظه‌ای CPU/حافظه می‌دهد (مثلاً حافظه ≈ 30,064,640 bytes در سناریوی leak).
- کد `liara_metrics`، `gatherDiagnosis` و `verify_fix` به epoch-ms اصلاح شد؛ ولی تا رفع 503، تشخیص روند منابع ممکن نیست و باید از health/events استفاده شود.

### لاگ runtime: پارامترهای v2 و fallback ناقص
- `GET /v2/projects/{app}/logs` با `start` ISO پاسخ **400** (`start must be a number`) و با `last_lines` عدد پاسخ **400** (`last_lines must be a boolean`) داد.
- با `start`/`end` عددی و `last_lines:false` پاسخ `{"data":[]}` بود؛ `last_lines:true` هم **400 Bad Request** داد. fallback به v1 فقط یک خط نامرتبط برگرداند: `Please upgrade your client using: ...`.
- در نتیجه لاگ‌های اپ (شامل `[BUG] leak active` و خطاهای 500) از API در دسترس نبودند؛ شواهد اصلی از `/health`، `liara_events` (رویدادهای `oom`/`start`/`die`) و `http_probe` گرفته شد.

### شواهد واقعی leak و رفع آن
- با `BUG_MODE=leak`: `extMB` از **8.5MB** به **473.5MB** در ~۹۵ ثانیه رسید و سه رویداد `oom` ثبت شد؛ `uptime` ریست شد.
- بعد از `BUG_MODE=off` و ری‌استارت: `extMB` در چهار نمونهٔ ۶۰ثانیه‌ای ثابت **3.5MB** ماند، `uptime` صعودی بود و OOM جدیدی ثبت نشد.

### محدودیت اندازه‌گیری latency
- پروب‌های محلی به `agate-liara.liara.run` در حالت سالم هم p50 حدود **1.3–2.1s** نشان می‌دهند (احتمالاً مسیر شبکه/VPN). برای سناریوی slow باید همین baseline در نظر گرفته شود، نه یک عدد مطلق.
