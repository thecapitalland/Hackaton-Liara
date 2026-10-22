/**
 * تست سطح سرور: اتصال MCP، فهرست ابزارها، annotations و پیام فارسی نبودن توکن.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/index.js";

async function connect() {
  const server = createServer();
  const client = new Client({ name: "agate-test", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test("سرور MCP ابزارهای مورد انتظار را معرفی می‌کند", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);

  for (const expected of [
    "ping",
    "liara_status",
    "liara_list_apps",
    "liara_logs",
    "liara_metrics",
    "liara_events",
    "liara_plans",
    "liara_releases",
    "http_probe",
    "audit_tail",
    "liara_create_app",
    "liara_deploy",
    "liara_set_env",
    "rollback_last_env_change",
    "liara_restart",
    "liara_scale",
    "liara_resize",
    "liara_add_domain",
    "liara_enable_ssl",
    "propose_action",
    "execute_action",
    "deploy_project",
    "diagnose",
    "apply_fix",
    "verify_fix",
    "connect_domain",
    "watch_after_deploy",
    "watch_app",
    "guide_domain_registration",
    "guide_rollback",
    "guide_github_deploy",
  ]) {
    assert.ok(names.includes(expected), `ابزار ${expected} ثبت نشده است`);
  }
});

test("ابزارهای فقط‌خواندنی annotation درست دارند و ابزارهای نوشتنی صریحاً غیرخواندنی‌اند", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  const byName = new Map(tools.map((t) => [t.name, t]));

  assert.equal(byName.get("liara_status")?.annotations?.readOnlyHint, true);
  assert.equal(byName.get("liara_logs")?.annotations?.readOnlyHint, true);
  assert.equal(byName.get("liara_restart")?.annotations?.readOnlyHint, false);
  assert.equal(byName.get("rollback_last_env_change")?.annotations?.readOnlyHint, false);
  assert.equal(byName.get("deploy_project")?.annotations?.readOnlyHint, false);
  assert.equal(byName.get("watch_app")?.annotations?.readOnlyHint, false);
});

test("بدون توکن، ابزار لیارا پیام فارسی راهنما برمی‌گرداند", async () => {
  const previous = process.env["LIARA_API_TOKEN"];
  process.env["LIARA_API_TOKEN"] = "";
  try {
    const { client } = await connect();
    const res = await client.callTool({ name: "liara_list_apps", arguments: {} });
    const text = (res.content as { type: string; text: string }[])[0]?.text ?? "";
    assert.match(text, /توکن لیارا تنظیم نشده است/);
    assert.match(text, /LIARA_API_TOKEN/);
  } finally {
    if (previous === undefined) delete process.env["LIARA_API_TOKEN"];
    else process.env["LIARA_API_TOKEN"] = previous;
  }
});

test("ابزار ping همیشه کار می‌کند", async () => {
  const { client } = await connect();
  const res = await client.callTool({ name: "ping", arguments: {} });
  const text = (res.content as { type: string; text: string }[])[0]?.text ?? "";
  assert.match(text, /Agate-Liara فعال است/);
});
