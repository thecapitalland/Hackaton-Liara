/**
 * تست سایت دمو: /health همیشه ۲۰۰ است و هر حالت باگ رفتار توصیف‌شده را دارد.
 * اجرا:  node demo-site/test.mjs   (یا npm run demo:test)
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createServer } from "./server.mjs";

const KEY = process.env.ADMIN_KEY ?? 'local-test-only';
process.env.ADMIN_KEY = KEY;
let server;
let base;

before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function setMode(mode) {
  const res = await fetch(`${base}/__agate-admin`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-admin-key": KEY,
    },
    body: JSON.stringify({ mode }),
  });
  assert.equal(res.status, 200, `تغییر حالت ناموفق بود: ${res.status}`);
}

describe("Agate Co. — سایت دمو", () => {
  it("/health همیشه ۲۰۰ است و فیلدهای لازم را دارد", async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ok");
    assert.ok(typeof body.bugMode === "string");
    assert.ok(typeof body.uptime === "number");
    assert.ok(typeof body.memMB === "number");
  });

  it("حالت سالم: صفحهٔ اصلی ۲۰۰ و شامل محتوای برند است", async () => {
    await setMode("off");
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Agate Co\./);
    assert.match(html, /لیارا/);
    assert.match(html, /خارج از محدودهٔ این ارائه/);
    assert.match(html, /APPROVAL_POLICY|strict/);
    assert.doesNotMatch(html, /هر نوشتنی، تأیید انسانی/);
  });

  it("حالت slow: پاسخ صفحهٔ اصلی تأخیر دارد", async () => {
    await setMode("slow");
    const started = Date.now();
    const res = await fetch(`${base}/`);
    const elapsed = Date.now() - started;
    assert.equal(res.status, 200);
    assert.ok(elapsed >= 1900, `تأخیر مورد انتظار بود، ${elapsed}ms اندازه‌گیری شد`);
    await setMode("off");
  });

  it("حالت error500: صفحهٔ اصلی و /api/challenges خطا می‌دهند ولی /health سالم می‌ماند", async () => {
    await setMode("error500");
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 500);

    const api = await fetch(`${base}/api/challenges`);
    assert.equal(api.status, 500);

    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.status, "ok");
    assert.equal(body.bugMode, "error500");
    await setMode("off");
  });

  it("حالت leak: حافظهٔ نگه‌داشته‌شده به‌صورت پیوسته بالا می‌رود", async () => {
    await setMode("leak");
    const read = async () => {
      const h = await (await fetch(`${base}/health`)).json();
      return h.memMB + h.extMB;
    };
    const first = await read();
    await new Promise((r) => setTimeout(r, 3200));
    const second = await read();
    assert.ok(second > first, `انتظار رشد حافظه بود: ${first} → ${second}`);
    await setMode("off");
  });

  it("query string حالت باگ را عوض نمی‌کند و کلید را در صفحه نمی‌گذارد", async () => {
    await setMode("off");
    const res = await fetch(`${base}/__agate-admin?key=${encodeURIComponent(KEY)}&mode=leak`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.doesNotMatch(html, new RegExp(KEY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(html, /x-admin-key/);
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.bugMode, "off");
  });

  it("POST بدون کلید یا با کلید اشتباه حالت را عوض نمی‌کند", async () => {
    await setMode("off");
    const missing = await fetch(`${base}/__agate-admin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "leak" }),
    });
    assert.equal(missing.status, 404);
    const wrong = await fetch(`${base}/__agate-admin`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": `${KEY}-nope` },
      body: JSON.stringify({ mode: "slow" }),
    });
    assert.equal(wrong.status, 404);
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.bugMode, "off");
  });

  it("پنل فرم تغییر حالت را نشان می‌دهد", async () => {
    const res = await fetch(`${base}/__agate-admin`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /leak/);
    assert.match(html, /error500/);
    assert.match(html, /data-mode="slow"/);
  });
});
