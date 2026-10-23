# محدودیت‌ها و وضعیت صادقانه

آخرین به‌روزرسانی: **۲۰۲۶-۱۰-۲۳**.

## وضعیت فعلی

مرجع وضعیت زنده بخش **Current Status** در [`README.md`](../README.md) است.

- preflight پایه **۴/۴** موفق است.
- اپ `agate-liara` با پلن `small-g2` و شبکهٔ `6ada1e64b3b5ca83e1ee0ce1` ساخته شده و اکنون `ACTIVE` است.
- آخرین انتشار تأییدشدهٔ این تغییر `6adb239b2c3f63ca360563ab` به `READY` رسید. جزئیات در README Current Status است.
- `https://agate-liara.liara.run/` و `/health` بعد از همان دیپلوی هر دو **HTTP 200** بودند. SLA نیست.
- `liara_status` نام کلیدهای env را نشان می‌دهد و مقدارها را ماسک می‌کند. `diagnose` و LLM این فهرست و مقدارها را نمی‌بینند. نام کلیدها در README نوشته نمی‌شود.
- اتصال **native MCP** در OpenCode 2.1.2 با `codemode:false` برقرار شد و `agate-liara_ping` و `agate-liara_liara_list_apps` مستقیماً از لیست ابزارهای OpenCode فراخوانی شدند.
- تمرین زندهٔ rollback و remediation عمداً به زمان ضبط ویدیو موکول شده است. در این تغییر env نوشته نشد. دیپلوی دمو یک انتشار تأییدشده بود و خودش سرویس را بازنشانی می‌کند.

## محدودیت‌های API

- rollback endpoint عمومی، log streaming، plans مستقل، health-check API و ثبت/خرید دامنه در API لیارا وجود ندارد. راهنماها جایگزین را اعلام می‌کنند، نه endpoint ساختگی.
- دیپلوی GitHub با GitHub Action و Liara CLI انجام می‌شود؛ راهنما فایل workflow می‌دهد، آن را خودکار ایجاد یا منتشر نمی‌کند.
- `connect_domain` افزودن دامنه، خواندن DNS و پیشنهاد SSL دارد؛ نوشتن zone/record در Liara DNS پیاده نشده است. رکوردها را دستی ثبت کنید.
- `update-envs` کل فهرست env را جایگزین می‌کند؛ سرور read/merge/write انجام می‌دهد و فقط کلیدهای واقعاً تغییرکرده را در journal محلی ثبت می‌کند.
- ناسازگاری `bundlePlanID` بین GET و POST دیده شده است؛ کاتالوگ با فیلتر strict و quote تازه اعتبارسنجی می‌شود و هیچ جایگزینی خودکار انجام نمی‌شود.
- واحد CPU/RAM در متریک تأیید نشده و عدد خام گزارش می‌شود؛ ارتقای پلن فقط با تأیید انسان است.
- دامنهٔ پیش‌فرض `*.liara.run` ممکن است در پاسخ `domains` دیده نشود؛ برای سلامت باید مستقل probe شود.

## باقی‌مانده‌های پیاده‌سازی / آزمون

- **Live env rollback / live watcher remediation:** `NOT_RUN` — برای ویدیو نگه داشته شده؛ `APPROVAL_POLICY=strict` است و هیچ mutationای انجام نشده.
- **سایر IDEها:** فقط OpenCode 2.1.2 به‌صورت native تأیید شده است. VS Code، Cursor و Codex هنوز `NOT_RUN` هستند.
- **پایش ۲۴ساعته:** `watch_after_deploy` و `watch_app` برای پایش کوتاه‌مدت‌اند؛ جایگزین مانیتورینگ تولیدی نیستند.
- **تشخیص:** قاعده‌محور است؛ «مشاهده‌شده» یعنی مشاهدهٔ سیگنال، نه اثبات علت ریشه‌ای. عدد confidence احتمال آماری کالیبره‌شده نیست.
- **LLM:** لاگ‌ها دادهٔ غیرقابل‌اعتمادند؛ LLM فقط از فهرست علت‌های مجاز انتخاب می‌کند و اجازهٔ تولید عملیات ندارد. ماسک‌کردن اسرار شناخته‌شده جایگزین حذف همهٔ اطلاعات حساس دلخواه در لاگ نیست.
- **State محلی:** approval/audit/journal/baseline برای یک فرایند MCP طراحی شده‌اند؛ multi-process locking، رمزگذاری state و sandbox تولیدی وجود ندارد. دسترسی پوشهٔ `.agate` باید محدود باشد. مقادیر pending به‌صورت محلی ذخیره می‌شوند و فقط خروجی‌ها ماسک هستند.
- **Baseline:** به‌ازای اپ است؛ تشخیص جدید baseline قبلی را جایگزین می‌کند. `verify_fix` شناسهٔ ناهماهنگ را رد می‌کند و نبود baseline را موفقیت حساب نمی‌کند.
- **دمو:** fault injection عمدی دارد و برای محیط تولید مناسب نیست. تغییر `BUG_MODE` فقط با POST و هدر `X-Admin-Key` است؛ کلید خالی یا query string حالت را عوض نمی‌کند. توروب و والکس خارج از محدودهٔ این ارائه هستند. LangGraph هم خارج از محدوده و کار آینده است.
- **انتشار:** public کردن مخزن، ضبط ویدیو، ارسال مسابقه و هر عملیات هزینه‌دار جدید نیازمند تصمیم/تأیید جداگانه است.

## وضعیت milestone

| مرحله | وضعیت |
|---|---|
| M0 — build / MCP محلی | PASS |
| M1 — auth / preflight | PASS (۴/۴) |
| M2 — app create / deploy | PASS — اپ `ACTIVE` و releaseها `READY` |
| M3 — خواندن live | PASS (read-only) |
| M4 — تشخیص / پایش | PASS (unit + live read-only) |
| M5 — remediation live | NOT_RUN (تعویق به ویدیو) |
| M6 — مستندات / اتصال IDE | OpenCode PASS؛ سایر IDEها NOT_RUN |

هیچ‌کدام از این وضعیت‌ها تضمین آمادگی تولید یا SLA نیست. جزئیات شواهد در [`TEST_EVIDENCE.md`](TEST_EVIDENCE.md) و اختلاف‌های API در [`LIARA_API.md`](LIARA_API.md) ثبت شده‌اند.
