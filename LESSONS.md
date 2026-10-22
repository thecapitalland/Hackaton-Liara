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
