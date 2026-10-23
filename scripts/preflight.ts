/**
 * Agate-Liara — preflight فقط‌خواندنی روی API زندهٔ لیارا.
 *
 * اجرا:  npm run preflight
 * هیچ درخواست نوشتنی (POST/PUT/DELETE) ارسال نمی‌شود.
 * خروجی: کد وضعیت + شکل پاسخ (بدون توکن و بدون مقادیر حساس)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { config, hasToken } from "../src/config.js";
import { redact } from "../src/redact.js";
import { runReadOnlyPreflight } from "../src/liara/preflight-run.js";

async function main(): Promise<void> {
  console.log("════════════════════════════════════════════════════════════");
  console.log(" Agate-Liara — preflight فقط‌خواندنی");
  console.log(` بیس API : ${config.apiBase}`);
  console.log(` بیس DNS : ${config.dnsBase}`);
  console.log(` تیم    : ${config.teamId ? "تنظیم شده (در هدر/کوئری اعمال می‌شود)" : "ندارد"}`);
  console.log("════════════════════════════════════════════════════════════");

  if (!hasToken()) {
    console.error("\n❌ LIARA_API_TOKEN تنظیم نشده است.");
    console.error("   آن را در فایل .env ریشهٔ مخزن قرار دهید و دوباره اجرا کنید.\n");
    process.exit(2);
  }

  const report = await runReadOnlyPreflight();
  for (const probe of report.probes) {
    if (probe.ok) console.log(`✅ ${probe.name.padEnd(34)} ${String(probe.status).padEnd(4)} ${probe.shape ?? ""}`);
    else console.log(`❌ ${probe.name.padEnd(34)} ${String(probe.status ?? "—").padEnd(4)} ${probe.error}`);
  }

  const failed = report.probes.filter((probe) => !probe.ok);
  const markdown = `# Live API preflight\n\n${report.ranAt}\n\n${report.probes
    .map((probe) => `- ${probe.name}: ${probe.status ?? "network error"}; ${probe.shape ?? probe.error}`)
    .join("\n")}`;
  mkdirSync("docs", { recursive: true });
  writeFileSync("docs/PREFLIGHT_LATEST.md", redact(markdown), "utf8");
  console.log("\n════════════════════════════════════════════════════════════");
  console.log(` نتیجه: ${report.probes.length - failed.length}/${report.probes.length} بررسی موفق`);
  if (failed.length) {
    console.log(" ناموفق‌ها:");
    for (const item of failed) console.log(`   • ${item.name} — ${item.error}`);
  }
  console.log(` گزارش کامل: ${report.reportPath}`);
  console.log("════════════════════════════════════════════════════════════");
  if (!report.ready) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error("preflight با خطا متوقف شد:", err);
  process.exit(1);
});
