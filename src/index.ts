#!/usr/bin/env node
/**
 * Agate-Liara — سرور MCP (انتقال stdio).
 *
 * نکتهٔ مهم: stdout متعلق به پروتکل MCP است؛ همهٔ لاگ‌ها باید روی stderr
 * نوشته شوند تا کلاینت خراب نشود.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveElicitationResponse, setElicitor } from "./approval.js";
import { config, PACKAGE_ROOT } from "./config.js";
import { fa } from './i18n/fa.js';
import { audited, errorResult } from './tools/common.js';
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";
import { registerCompositeTools } from "./tools/composite.js";
import { registerWatchTools } from "./tools/watch.js";

export const SERVER_NAME = "agate-liara";
export const SERVER_VERSION = "0.1.0";

/** پیام راهنمای اتصال که کلاینت MCP بعد از initialize می‌بیند. */
export const SERVER_INSTRUCTIONS = [
  "Agate-Liara — دستیار DevOps/SRE برای لیارا (MCP stdio).",
  "شروع: ping، سپس liara_status یا liara_list_apps.",
  "عیب‌یابی: diagnose(app, symptom) → apply_fix(incidentId) → verify_fix.",
  "پایش: watch_app(app, cycles, intervalSec) یا npm run watch؛ هر چرخه سه مسیر را سه بار پروب می‌کند و در صورت رخداد، diagnose را با همان ۹ نمونه و رویدادهای ۱۰ دقیقه اجرا می‌کند.",
  "ایمنی: خواندن‌ها آزادند؛ هر نوشتن از APPROVAL_POLICY و runGuardedAction عبور می‌کند. توکن/کلید را در چت ننویسید.",
  "راهکار قابل بازگشت: rollback_last_env_change (risk=medium) فقط وقتی پیشنهاد می‌شود که تغییر env دقیقی در ۱۰ دقیقهٔ قبل در تاریخچهٔ محلی یا baseline سالم ثبت شده باشد؛ در غیر این صورت restart. تأیید طبق APPROVAL_POLICY.",
  "مقدار env و بدنهٔ /health ورودی تشخیص نیستند؛ فقط وجود/زمان تغییر env برای انتخاب اقدام بررسی می‌شود.",
  "بررسی: INVESTIGATE_MODE=agentic (پیش‌فرض وقتی LLM تنظیم است) فقط ابزارهای read-only را به مدل می‌دهد. fixed همان مسیر قبلی است.",
].join("\n");

/** ساخت سرور و ثبت ابزارها */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  /* ── elicitation: تأیید بومی داخل IDE ─────────────────────────────── */
  setElicitor(async (summaryFa, choices, impact) => {
    const caps = server.server.getClientCapabilities();
    if (!caps?.elicitation) {
      throw new Error("کلاینت از elicitation پشتیبانی نمی‌کند");
    }
    const res = await server.server.elicitInput({
      message: `${summaryFa}\n\n⚠️ اثر: ${impact}`,
      requestedSchema: {
        type: "object",
        properties: {
          choice: {
            type: "string",
            title: "انتخاب شما",
            description: "گزینهٔ موردنظر را انتخاب کنید",
            enum: choices.map((c) => c.value),
            enumNames: choices.map((c) => c.labelFa),
          },
        },
        required: ["choice"],
      },
    });

    return resolveElicitationResponse(
      res.action,
      (res.content ?? {})["choice"],
      choices.map((choice) => choice.value),
    );
  });

  // Wrap all registrations, including composites, for audit/error coverage.
  const register = server.registerTool.bind(server);
  server.registerTool = ((name: string, definition: any, handler: any) => (register as any)(name, definition,
    async (args: any, extra: any) => audited(name, args?.app, args, async () => {
      if (!config.token && !['ping','audit_tail','guide_domain_registration','guide_github_deploy'].includes(name)) return errorResult(fa.missingToken, 'AUTH_REQUIRED');
      return handler(args, extra);
    }))) as typeof server.registerTool;
  registerReadTools(server);
  registerWriteTools(server);
  registerCompositeTools(server);
  registerWatchTools(server);

  return server;
}

/** اجرای سرور روی stdio */
export async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  transport.onerror = (err: unknown) => {
    process.stderr.write(`[agate-liara] transport error: ${String(err)}\n`);
  };

  await server.connect(transport);
  process.stderr.write(
    [
      `[agate-liara] ✅ آماده (v${SERVER_VERSION}، انتقال stdio)`,
      `[agate-liara] اپ‌های مجاز: ${config.allowedApps.join("، ") || "—"}`,
      `[agate-liara] توکن لیارا: ${config.token ? "تنظیم شده" : "تنظیم نشده (ابزارها پیام راهنما می‌دهند)"} | سیاست تأیید: ${config.approvalPolicy}`,
      `[agate-liara] پایش: اپ «${config.watchApp || "—"}» هر ${config.watchIntervalSec} ثانیه`,
      `[agate-liara] cwd=${process.cwd()} | state=${config.stateDir} | package=${PACKAGE_ROOT}`,
      `[agate-liara] شروع: ping → liara_list_apps → diagnose یا watch_app`,
    ].join("\n") + "\n",
  );

  const shutdown = async (): Promise<void> => {
    try {
      await server.close();
    } catch {
      /* بستن تمیز */
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// فقط وقتی مستقیم اجرا شده است (نه در حالت import) سرور بالا می‌آید.
const isDirectRun = (() => {
  const entry = process.argv[1] ?? "";
  return /index\.(ts|js)$/.test(entry) || /dist[\\/]index\.js$/.test(entry);
})();

if (isDirectRun) {
  const arg = process.argv[2];
  if (arg === "--version" || arg === "-v") {
    process.stdout.write(`${SERVER_NAME} ${SERVER_VERSION}\n`);
  } else if (arg === "--help" || arg === "-h") {
    process.stdout.write(
      [
        "Agate-Liara — سرور MCP برای لیارا",
        "",
        "اجرا:  node dist/index.js        (یا npx tsx src/index.ts)",
        "اتصال سراسری: node dist/index.js با مسیر مطلق و envFile مطلق؛ npm run install:cursor",
        "state: AGATE_STATE_DIR یا ریشهٔ پکیج/.agate؛ به cwd پروژهٔ دیگر وابسته نیست",
        "شروع: ping → liara_list_apps → diagnose/watch_app",
        "متغیرها: LIARA_API_TOKEN (الزامی)، LIARA_TEAM_ID، LIARA_API_BASE، LIARA_DNS_BASE،",
        "          AGATE_ALLOWED_APPS، AGATE_STATE_DIR، APPROVAL_POLICY، WATCH_APP، WATCH_INTERVAL_SEC،",
        "          WATCH_COOLDOWN_SEC، WATCH_REMEDIATE، LLM_BASE_URL، LLM_API_KEY، LLM_MODEL، LLM_MODEL_FALLBACK، LLM_DECISION_MODEL، INVESTIGATE_MODE",
        "اقدام قابل بازگشت: rollback_last_env_change (risk=medium؛ در نبود مدرک → restart)",
      ].join("\n") + "\n",
    );
  } else {
    main().catch((err: unknown) => {
      process.stderr.write(`[agate-liara] خطای راه‌اندازی: ${String(err)}\n`);
      process.exit(1);
    });
  }
}
