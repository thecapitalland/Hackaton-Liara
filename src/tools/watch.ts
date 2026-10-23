/**
 * ابزار MCP پایش مداوم. یک یا چند چرخهٔ پایش را اجرا می‌کند؛
 * حلقهٔ بی‌پایان در `npm run watch` قرار دارد.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config, isAllowedApp } from "../config.js";
import { fa } from "../i18n/fa.js";
import { sleep } from "../probe.js";
import { result } from "./common.js";
import { runWatchCheck, watchSummary, type WatchCheckResult } from "../watch.js";

const WATCH_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export function registerWatchTools(server: McpServer): void {
  server.registerTool(
    "watch_app",
    {
      title: "پایش مداوم و رفع سیاست‌محور",
      description:
        "هر چرخه مسیرهای probePaths یا probePaths داخل liara.json را پروب می‌کند. اگر هیچ‌کدام نباشد مسیرهای دمو / و /api/challenges و /api/status استفاده می‌شوند. " +
        "۵xx، timeout و خطای اتصال خطا هستند. اگر هیچ نمونهٔ موفقی نماند رخداد outage ساخته می‌شود. " +
        "یک خطای تکی و گذرا فقط هشدار است؛ remediation بعد از دو چرخهٔ پشت‌سرهم یا حداقل دو پروب ناموفق است. " +
        "p50 بالای ۱۵۰۰ms یا رویداد جدید OOM/ری‌استارت هم diagnose را بدون env اجرا می‌کند. " +
        "اقدام درمانی از APPROVAL_POLICY پیروی می‌کند و هر رخداد با cooldown در audit.jsonl ثبت می‌شود.",
      inputSchema: {
        app: z.string().min(1).describe("نام اپ در لیارا"),
        cycles: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(1)
          .describe("تعداد چرخه‌های پایش در همین فراخوانی؛ برای پایش دائمی از npm run watch استفاده کنید"),
        intervalSec: z
          .number()
          .int()
          .min(10)
          .max(3600)
          .optional()
          .describe("فاصلهٔ چرخه‌ها؛ پیش‌فرض WATCH_INTERVAL_SEC"),
        remediate: z
          .boolean()
          .optional()
          .describe("اجازهٔ اقدام درمانی سیاست‌محور پس از تشخیص (strict = تأیید، balanced = low خودکار)"),
        probePaths: z.array(z.string()).optional().describe("مسیرهای پروب این اپ"),
        projectPath: z.string().optional().describe("مسیر مطلق پروژه برای خواندن probePaths از liara.json"),
      },
      annotations: WATCH_ANNOTATIONS,
    },
    async ({ app, cycles, intervalSec, remediate, probePaths, projectPath }) => {
      if (!isAllowedApp(app)) {
        return result(fa.appNotAllowed(app, config.allowedApps), {
          ok: false,
          code: "APP_NOT_ALLOWLISTED",
        });
      }

      if (!config.token) {
        return result(fa.missingToken, { ok: false, code: "AUTH_REQUIRED" });
      }

      const allowRemediation = remediate ?? config.watchRemediate;
      const reports: WatchCheckResult[] = [];
      try {
        for (let i = 0; i < cycles; i++) {
          reports.push(await runWatchCheck({ app, remediate: allowRemediation, probePaths, projectPath }));
          if (i < cycles - 1) {
            await sleep((intervalSec ?? config.watchIntervalSec) * 1000);
          }
        }
      } catch (err) {
        return result(`❌ پایش ناموفق بود: ${(err as Error).message}`, {
          ok: false,
          code: "WATCH_FAILED",
        });
      }

      const text = reports.map((r) => r.reportFa).join("\n\n──────────\n\n");
      return result(text, {
        ok: true,
        app,
        cycles: reports.length,
        intervalSec: intervalSec ?? config.watchIntervalSec,
        reports: reports.map(watchSummary),
      });
    },
  );
}
