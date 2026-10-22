/**
 * Agate-Liara — همهٔ متن‌های فارسی در یک فایل.
 * هیچ متن کاربرمحوری نباید خارج از این فایل نوشته شود.
 */

export const fa = {
  /** پیام نبودن توکن — دقیقاً مطابق مشخصات */
  missingToken:
    "❌ توکن لیارا تنظیم نشده است. لطفاً LIARA_API_TOKEN را در فایل .env یا تنظیمات MCP قرار دهید (console.liara.ir ← API).",

  /** خطاهای عمومی */
  auth: "❌ توکن نامعتبر یا دسترسی ندارد. توکن را در console.liara.ir ← API بررسی کنید.",
  notFound: "❌ اپ پیدا نشد. نام اپ را بررسی کنید (لیست: liara_list_apps).",
  rateLimit: "❌ محدودیت نرخ API لیارا؛ چند ثانیه بعد دوباره تلاش کنید.",
  network: "❌ ارتباط با API لیارا برقرار نشد. اتصال شبکه را بررسی کنید.",
  timeout: "❌ پاسخی از لیارا دریافت نشد (اتمام مهلت). دوباره تلاش کنید.",
  serverError: "❌ خطای سمت سرور لیارا. کمی بعد دوباره تلاش کنید.",
  unknown: "❌ خطای ناشناخته در ارتباط با لیارا.",
  badRequest: "❌ درخواست نامعتبر بود (پارامترها را بررسی کنید).",
  conflict: "❌ این عملیات با وضعیت فعلی تداخل دارد.",

  /** ابزارهای read-only */
  statusHeader: (app: string) => `📊 وضعیت اپ «${app}»`,
  logsHeader: (app: string, minutes: number) => `📜 لاگ‌های «${app}» (${minutes} دقیقه اخیر)`,
  noLogs: "لاگی در بازهٔ انتخابی یافت نشد.",
  metricsHeader: (app: string) => `📈 متریک‌های «${app}»`,
  metricsUnavailable: "متریک در دسترس نبود (طبق مستندات API لیارا محدود است).",
  eventsHeader: (app: string) => `🧾 رویدادهای «${app}»`,
  noEvents: "رویدادی یافت نشد.",
  plansHeader: "💳 پلن‌های موجود در حساب لیارا",
  releasesHeader: (app: string) => `🚀 انتشارهای «${app}»`,
  noReleases: "انتشاری یافت نشد.",
  appsHeader: "📦 اپ‌های حساب لیارا",
  noApps: "هیچ اپی در این حساب یافت نشد.",
  probeHeader: (target: string) => `🌐 بررسی سلامت «${target}»`,

  /** ابزارهای نوشتنی */
  needApproval: "⏳ نیاز به تأیید",
  rejected: "❌ عملیات لغو شد؛ هیچ تغییری اعمال نشد.",
  approved: "✅ تأیید شد؛ عملیات اجرا شد.",
  appNotAllowed: (app: string, allowed: string[]) =>
    `❌ اپ «${app}» در لیست مجاز نیست. اپ‌های مجاز: ${allowed.join("، ")}`,

  /** استقرار */
  deployDetect: "⏳ تشخیص استک پروژه...",
  deployPackage: "⏳ بسته‌بندی سورس...",
  deployUpload: "✅ آپلود انجام شد",
  deployRelease: "⏳ ساخت (build)...",
  deployDone: "✅ انتشار موفق",
  deployLive: "🌐 آدرس زنده",
  deployFailed: "❌ انتشار ناموفق بود",
  deployRollbackHint:
    "ℹ️ در صورت نیاز به بازگشت، از طریق guide_rollback آخرین انتشار موفق را دوباره دیپلوی کنید (روی بکاپ رویدادی API محدود است).",

  /** تشخیص */
  diagnoseHeader: (app: string) => `🔍 تحلیل رخداد اپ «${app}»`,
  observed: "مشاهده‌شده",
  inferred: "استنباط",
  nextStep: "گام بعدی",
  noCause: "علت مشخصی پیدا نشد؛ شواهد بیشتری لازم است.",
  inconclusive: "نتیجه قطعی نیست — شواهد کافی جمع نشد.",

  /** اعتبارسنجی */
  fixed: "✅ تأیید شد — مشکل برطرف شده است.",
  notFixed: "❌ مشکل باقی است — وضعیت بهبود نکرد.",
  cannotVerify: "⚠️ تأیید ممکن نشد (دادهٔ کافی برای مقایسه نبود).",

  /** محدودیت‌ها */
  apiLimitation: (what: string) => `⚠️ محدودیت API لیارا: ${what}`,
} as const;

/** ماسک کردن مقدار متغیر محیطی برای نمایش امن */
export function maskValue(value: string): string {
  if (!value) return "(empty)";
  if (value.length <= 4) return "••••";
  return `${value.slice(0, 2)}${"•".repeat(Math.min(8, value.length - 4))}${value.slice(-2)}`;
}
