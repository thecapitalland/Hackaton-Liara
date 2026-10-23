/**
 * اثبات اتصال GapGPT بدون IP دستی.
 * اول resolver خودِ Node (dns.lookup). اگر loopback بود، همان hostname با curl
 * که از resolver سیستم‌عامل استفاده می‌کند. کلید و بدنه چاپ نمی‌شوند.
 */
import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../src/config.js";
import { isLoopbackAddress } from "../src/diagnose/resolver.js";

const url = new URL(config.llmBaseUrl);
const rows = await lookup(url.hostname, { all: true });
const addresses = rows.map((row) => row.address);
const loopback = addresses.some(isLoopbackAddress);
console.log(`node-lookup host=${url.hostname} loopback=${loopback} count=${addresses.length}`);

const dir = mkdtempSync(path.join(tmpdir(), "agate-gap-"));
let status = "";
try {
  const cfg = path.join(dir, "curl.cfg");
  const body = path.join(dir, "body.json");
  const out = path.join(dir, "out.bin");
  writeFileSync(body, JSON.stringify({
    model: config.llmModel,
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 1,
  }));
  writeFileSync(cfg, [
    `url = "${config.llmBaseUrl.replace(/\/$/, "")}/chat/completions"`,
    'request = "POST"',
    'header = "content-type: application/json"',
    `header = "Authorization: Bearer ${config.llmApiKey}"`,
    `data-binary = "@${body.replace(/\\/g, "/")}"`,
    "silent",
    "show-error",
  ].join("\n"));
  status = await new Promise<string>((resolve, reject) => {
    const child = spawn("curl.exe", ["--config", cfg, "-o", out, "-w", "%{http_code} %{remote_ip}", "--max-time", "25"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`curl exit ${code}`));
      else resolve(stdout.trim());
    });
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
const [http, ip] = status.split(" ");
const publicIp = Boolean(ip && !isLoopbackAddress(ip));
console.log(`curl host=${url.hostname} status=${http} public=${publicIp}`);
console.log(`product=${loopback ? "refused" : "hostname"}`);
if (loopback || http !== "200" || !publicIp) process.exit(1);
