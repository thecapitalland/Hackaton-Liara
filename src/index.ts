#!/usr/bin/env node
/**
 * Agate-Liara — سرور MCP (انتقال stdio).
 *
 * نکتهٔ مهم: stdout متعلق به پروتکل MCP است؛ همهٔ لاگ‌ها باید روی stderr
 * نوشته شوند تا کلاینت خراب نشود.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { setElicitor } from "./approval.js";
import { config } from "./config.js";
import { fa } from './i18n/fa.js';
import { audited, errorResult } from './tools/common.js';
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";
import { registerCompositeTools } from "./tools/composite.js";

export const SERVER_NAME = "agate-liara";
export const SERVER_VERSION = "0.1.0";

/** ساخت سرور و ثبت ابزارها */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Agate-Liara: دستیار DevOps/SRE برای لیارا. ابزارهای فقط‌خواندنی مستقیم اجرا می‌شوند؛ " +
        "عملیات نوشتنی نیازمند تأیید کاربر هستند. خروجی‌ها فارسی و کوتاه هستند.",
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

    if (res.action === "accept") {
      const value = (res.content ?? {})["choice"];
      const chosen = typeof value === "string" ? value : (choices[0]?.value ?? "");
      if (chosen === "cancel") {
        return { approved: false, reason: "کاربر عملیات را لغو کرد." };
      }
      return { approved: true, choice: chosen };
    }
    return {
      approved: false,
      reason:
        res.action === "decline"
          ? "کاربر درخواست را رد کرد."
          : "کاربر پنجرهٔ تأیید را بست (لغو).",
    };
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
    `[agate-liara] آماده — اپ‌های مجاز: ${config.allowedApps.join("، ")} | توکن: ${
      config.token ? "تنظیم شده" : "تنظیم نشده"
    }\n`,
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
        "متغیرها: LIARA_API_TOKEN (الزامی)، LIARA_TEAM_ID، LIARA_API_BASE، LIARA_DNS_BASE،",
        "          AGATE_ALLOWED_APPS، LLM_BASE_URL، LLM_API_KEY، LLM_MODEL",
      ].join("\n") + "\n",
    );
  } else {
    main().catch((err: unknown) => {
      process.stderr.write(`[agate-liara] خطای راه‌اندازی: ${String(err)}\n`);
      process.exit(1);
    });
  }
}
