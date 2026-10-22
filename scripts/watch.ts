/**
 * اجرای دائمی پایش Agate-Liara.
 *
 * مثال:
 *   npm run watch
 *   npm run watch -- --app agate-liara
 *   npm run watch -- --once
 */
import { config, hasToken, isAllowedApp } from "../src/config.js";
import { sleep } from "../src/probe.js";
import { runWatchCheck } from "../src/watch.js";

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const once = process.argv.includes("--once");
const noRemediate = process.argv.includes("--no-remediate");
const app = (argValue("--app") ?? config.watchApp).trim();

if (!app) {
  console.error("❌ نام اپ مشخص نیست؛ WATCH_APP یا --app را تنظیم کنید.");
  process.exit(1);
}
if (!isAllowedApp(app)) {
  console.error(`❌ اپ «${app}» در AGATE_ALLOWED_APPS نیست (${config.allowedApps.join("، ")}).`);
  process.exit(1);
}
if (!hasToken()) {
  console.error("❌ LIARA_API_TOKEN تنظیم نشده است؛ پایش به API لیارا نیاز دارد.");
  process.exit(1);
}

const intervalSec = config.watchIntervalSec;
const cooldownSec = config.watchCooldownSec;
console.log(
  `👀 پایش «${app}» آغاز شد — هر ${intervalSec} ثانیه، cooldown=${cooldownSec}s، ` +
    `سیاست=${config.approvalPolicy}، remediation=${noRemediate ? "خاموش" : "روشن"}`,
);
console.log("برای توقف: Ctrl+C\n");

let stopping = false;
process.on("SIGINT", () => {
  stopping = true;
  console.log("\n⏹️ توقف پایش درخواست شد.");
});

while (!stopping) {
  const started = Date.now();
  try {
    const check = await runWatchCheck({
      app,
      remediate: !noRemediate && config.watchRemediate,
    });
    console.log(check.reportFa);
    console.log("");
  } catch (err) {
    console.error(`❌ خطای چرخهٔ پایش: ${(err as Error).message}\n`);
  }

  if (once) break;
  const elapsed = Date.now() - started;
  const waitMs = Math.max(0, intervalSec * 1000 - elapsed);
  if (!stopping && waitMs > 0) await sleep(waitMs);
}

if (once) console.log("✅ یک چرخهٔ پایش تمام شد.");
