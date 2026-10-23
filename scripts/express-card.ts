/**
 * deploy_project با projectPath بیرون از مخزن، فقط تا کارت ساخت اپ و quote.
 * تأیید و اجرا نمی‌شود.
 */
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { setApprovalStatus } from "../src/approval.js";
import { createServer } from "../src/index.js";
import { fetchPlanCatalog } from "../src/liara/plans.js";

const projectPath = path.resolve("D:\\Hackaton\\express-sample");
const app = "agate-express-probe";
const catalog = await fetchPlanCatalog();
const pair = catalog.pairs[0];
if (!pair) throw new Error("پلن قیمت‌دار پیدا نشد.");

const server = createServer();
const client = new Client({ name: "express-card", version: "0.0.1" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
try {
  const res = await client.callTool({
    name: "deploy_project",
    arguments: {
      projectPath,
      app,
      planID: pair.planID,
      bundlePlanID: pair.bundlePlanID,
    },
  });
  const text = (res.content as { type: string; text?: string }[]).find((item) => item.type === "text")?.text ?? "";
  const code = (res.structuredContent as { code?: string } | undefined)?.code ?? "";
  console.log(`code=${code}`);
  console.log(text);
  const id = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(text)?.[0];
  if (code !== "APPROVAL_REQUIRED" || !id) throw new Error("کارت ساخت اپ ساخته نشد.");
  setApprovalStatus(id, "rejected");
  console.log(`local-card=${id} status=rejected-not-executed`);
} finally {
  await client.close();
  await server.close();
}
