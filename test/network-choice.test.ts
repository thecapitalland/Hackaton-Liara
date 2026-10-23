import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { listApprovals, setElicitor } from "../src/approval.js";
import { connectionDigest } from "../src/liara/preflight-gate.js";
import { parseNetworkList, suggestNetwork } from "../src/liara/networks.js";
import { quoteCreate } from "../src/liara/plans.js";
import { ensureApp } from "../src/tools/composite.js";
import { getAction } from "../src/tools/write.js";

function catalog() {
  return {
    plans: {
      projects: {
        "small-g2": { available: true, region: "iran", displayPrice: 475000, volume: 5, RAM: { amount: 0.5 }, CPU: { amount: 0.5 } },
      },
      projectBundlePlans: {
        "small-g2": { basic: { available: true, displayPrice: 275000 } },
      },
    },
  };
}

test("فهرست شبکه همان شکل promptNetwork است و پیشنهاد به شبکهٔ agate-liara می‌چسبد", () => {
  assert.equal(parseNetworkList({}), null);
  assert.deepEqual(parseNetworkList({ networks: [] }), []);
  assert.equal(parseNetworkList({ networks: [{ name: "x" }] }), null);
  const networks = parseNetworkList({
    networks: [
      { _id: "net-app", name: "agate-liara", createdAt: "2026-01-01" },
      { _id: "net-other", name: "other" },
    ],
  });
  assert.ok(networks);
  const attached = suggestNetwork(networks, {
    projects: [{ project_id: "agate-liara", type: "node", network: "net-app", created_at: "2026-01-01" }],
  });
  assert.equal(attached.recommended?.id, "net-app");
  assert.equal(attached.recommended?.name, "agate-liara");
  assert.match(attached.reasonFa, /agate-liara/);

  const asObject = suggestNetwork(networks, {
    projects: [{ project_id: "agate-liara", network: { _id: "net-other", name: "other" } }],
  });
  assert.equal(asObject.recommended?.id, "net-other");

  const only = suggestNetwork([{ id: "net-1", name: "solo" }], { projects: [] });
  assert.equal(only.recommended?.id, "net-1");
  assert.match(only.reasonFa, /فقط همین/);

  const ambiguous = suggestNetwork(networks, { projects: [] }, "missing-app");
  assert.equal(ambiguous.recommended, null);

  const stringIsNotAName = suggestNetwork(
    [
      { id: "net-real", name: "alpha" },
      { id: "net-other", name: "beta" },
    ],
    { projects: [{ project_id: "agate-liara", network: "alpha" }] },
  );
  assert.equal(stringIsNotAName.recommended, null);

  const objectNameIsNotAnId = suggestNetwork(
    [
      { id: "alpha", name: "kept" },
      { id: "net-other", name: "beta" },
    ],
    { projects: [{ project_id: "agate-liara", network: { name: "alpha" } }] },
  );
  assert.equal(objectNameIsNotAnId.recommended, null);
});

test("بدون شبکه کارت ساخت شبکه می‌آید و ساخت اپ پست نمی‌شود", async () => {
  const state = mkdtempSync(path.join(tmpdir(), "agate-net-empty-"));
  const previousState = process.env["AGATE_STATE_DIR"];
  const previousToken = process.env["LIARA_API_TOKEN"];
  process.env["AGATE_STATE_DIR"] = state;
  process.env["LIARA_API_TOKEN"] = "fixture-not-live";
  writeFileSync(
    path.join(state, "preflight-gate.json"),
    JSON.stringify({ connection: connectionDigest(), ready: true, ranAt: new Date().toISOString() }),
  );
  const methods: string[] = [];
  const original = globalThis.fetch;
  setElicitor(null);
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    methods.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/v1/networks") return new Response(JSON.stringify({ networks: [] }), { status: 200 });
    return new Response(JSON.stringify({ message: "missing" }), { status: 404 });
  };
  try {
    const out = await ensureApp("new-app", "node");
    assert.equal(out.code, "NETWORK_REQUIRED");
    assert.match(out.note ?? "", /liara_create_network/);
    assert.match(out.note ?? "", /high/);
    assert.match(out.note ?? "", /شبکهٔ داخلی/);
    assert.equal(methods.some((line) => line.startsWith("POST")), false);
    assert.equal(methods.includes("GET /v1/networks"), true);
    const cards = listApprovals();
    assert.equal(cards.length, 1);
    assert.equal(cards[0]?.tool, "liara_create_network");
    assert.equal(cards[0]?.risk, "high");
    assert.equal(cards[0]?.status, "pending");
    assert.equal(cards[0]?.params["networkName"], "new-app");
  } finally {
    globalThis.fetch = original;
    setElicitor(null);
    if (previousState === undefined) delete process.env["AGATE_STATE_DIR"];
    else process.env["AGATE_STATE_DIR"] = previousState;
    if (previousToken === undefined) delete process.env["LIARA_API_TOKEN"];
    else process.env["LIARA_API_TOKEN"] = previousToken;
    rmSync(state, { recursive: true, force: true });
  }
});

test("شبکهٔ اپ agate-liara با نام و شناسه روی کارت ساخت می‌آید و پست نمی‌شود", async () => {
  const state = mkdtempSync(path.join(tmpdir(), "agate-net-card-"));
  const previousState = process.env["AGATE_STATE_DIR"];
  const previousToken = process.env["LIARA_API_TOKEN"];
  process.env["AGATE_STATE_DIR"] = state;
  process.env["LIARA_API_TOKEN"] = "fixture-not-live";
  const methods: string[] = [];
  const original = globalThis.fetch;
  setElicitor(null);
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    methods.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/v1/networks") {
      return new Response(JSON.stringify({
        networks: [
          { _id: "net-app", name: "agate-liara" },
          { _id: "net-other", name: "other" },
        ],
      }), { status: 200 });
    }
    if (url.pathname === "/v1/projects") {
      return new Response(JSON.stringify({
        projects: [{ project_id: "agate-liara", type: "node", network: "net-app", created_at: "2026-01-01" }],
      }), { status: 200 });
    }
    if (url.pathname === "/v1/me") return new Response(JSON.stringify(catalog()), { status: 200 });
    return new Response(JSON.stringify({ message: "missing" }), { status: 404 });
  };
  try {
    const out = await ensureApp("new-app", "node");
    assert.equal(out.code, "APPROVAL_REQUIRED");
    assert.match(out.note ?? "", /agate-liara/);
    assert.match(out.note ?? "", /net-app/);
    assert.match(out.note ?? "", /شناسه/);
    assert.equal(methods.some((line) => line.startsWith("POST")), false);
    const cards = listApprovals();
    assert.equal(cards.length, 1);
    assert.equal(cards[0]?.tool, "liara_create_app");
    assert.equal(cards[0]?.params["network"], "net-app");
    assert.equal(cards[0]?.params["networkName"], "agate-liara");
  } finally {
    globalThis.fetch = original;
    setElicitor(null);
    if (previousState === undefined) delete process.env["AGATE_STATE_DIR"];
    else process.env["AGATE_STATE_DIR"] = previousState;
    if (previousToken === undefined) delete process.env["LIARA_API_TOKEN"];
    else process.env["LIARA_API_TOKEN"] = previousToken;
    rmSync(state, { recursive: true, force: true });
  }
});

test("چند شبکهٔ بی‌اتصال پست نمی‌شود و ساخت اپ بدون شناسه هم پست نمی‌شود", async () => {
  const state = mkdtempSync(path.join(tmpdir(), "agate-net-choose-"));
  const previousState = process.env["AGATE_STATE_DIR"];
  const previousToken = process.env["LIARA_API_TOKEN"];
  process.env["AGATE_STATE_DIR"] = state;
  process.env["LIARA_API_TOKEN"] = "fixture-not-live";
  const methods: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    methods.push(`${method} ${url.pathname}`);
    if (url.pathname === "/v1/networks") {
      return new Response(JSON.stringify({
        networks: [
          { _id: "net-a", name: "alpha" },
          { _id: "net-b", name: "beta" },
        ],
      }), { status: 200 });
    }
    if (url.pathname === "/v1/projects") return new Response(JSON.stringify({ projects: [] }), { status: 200 });
    if (url.pathname === "/v1/me") return new Response(JSON.stringify(catalog()), { status: 200 });
    return new Response(JSON.stringify({ message: "missing" }), { status: 404 });
  };
  try {
    const out = await ensureApp("new-app", "node");
    assert.equal(out.code, "NETWORK_REQUIRED");
    assert.match(out.note ?? "", /alpha/);
    assert.match(out.note ?? "", /net-a/);
    assert.match(out.note ?? "", /beta/);
    assert.match(out.note ?? "", /net-b/);
    assert.equal(listApprovals().length, 0);
    const params = { name: "new-app", platform: "node", planID: "small-g2", bundlePlanID: "basic" };
    const quote = await quoteCreate(params);
    const action = await getAction("liara_create_app")!.run({ ...params, quote });
    assert.equal(action.structured?.code, "NETWORK_REQUIRED");
    assert.equal(methods.some((line) => line.startsWith("POST")), false);
  } finally {
    globalThis.fetch = original;
    if (previousState === undefined) delete process.env["AGATE_STATE_DIR"];
    else process.env["AGATE_STATE_DIR"] = previousState;
    if (previousToken === undefined) delete process.env["LIARA_API_TOKEN"];
    else process.env["LIARA_API_TOKEN"] = previousToken;
    rmSync(state, { recursive: true, force: true });
  }
});
