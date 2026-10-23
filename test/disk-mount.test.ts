import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { decideApproval } from "../src/approval.js";
import { detectStack } from "../src/deploy/detect.js";
import {
  cardShowsDiskPlan,
  createsAreAuthorized,
  diskCreateBody,
  formatDiskCard,
  missingDiskSizeCard,
  mountsAreAuthorized,
  parseRemoteDisks,
  planDiskMounts,
  releaseDiskField,
} from "../src/deploy/disks.js";
import { buildReleaseBody } from "../src/tools/composite.js";

test("بدنهٔ release همان {name, mountTo} از CLI است و size را نمی‌فرستد", () => {
  const disks = releaseDiskField([
    { name: "data", mountTo: "/data", size: "2" },
  ]);
  assert.deepEqual(disks, [{ name: "data", mountTo: "/data" }]);
  assert.equal("size" in disks[0]!, false);
  const body = buildReleaseBody(
    {
      platform: "node",
      port: 3000,
      app: "sample",
      requiredEnv: [],
      exampleEnv: [],
      notes: [],
      disks: [{ name: "data", mountTo: "/data", size: "2" }],
    },
    "src_1",
  );
  assert.deepEqual(body["disks"], [{ name: "data", mountTo: "/data" }]);
  assert.deepEqual(diskCreateBody({ name: "data", size: "2" }), { name: "data", size: "2" });
});

test("دیسک موجود mount می‌شود و دیسک بدون size کارت دستی می‌سازد", () => {
  const remote = parseRemoteDisks({ disks: [{ name: "data", size: 5, mountedTo: "/ignored" }] });
  assert.deepEqual(remote, [{ name: "data", size: "5" }]);
  const ready = planDiskMounts([{ name: "data", mountTo: "/var/data" }], remote ?? []);
  assert.deepEqual(ready.creates, []);
  assert.deepEqual(ready.blocked, []);
  assert.match(formatDiskCard(ready), /data → \/var\/data/);
  assert.match(formatDiskCard(ready), /اندازه 5/);
  assert.equal(ready.releaseDisks[0]?.mountTo, "/var/data");

  const missing = planDiskMounts([{ name: "cache", mountTo: "/cache" }], remote ?? []);
  assert.deepEqual(missing.creates, []);
  const card = missingDiskSizeCard(missing.blocked);
  assert.equal(card.structured["code"], "DISK_SIZE_REQUIRED");
  assert.match(card.text, /cache → \/cache/);
  assert.equal(/\d+(\.\d+)?\s*GB/.test(card.text), false);
  assert.equal(parseRemoteDisks([{ name: "data" }]), null);
  assert.equal(parseRemoteDisks({ mounts: [] }), null);
});

test("size موجود در liara.json فقط برای ساخت است و باید روی کارت تأیید باشد", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agate-disk-"));
  try {
    writeFileSync(
      path.join(dir, "liara.json"),
      JSON.stringify({ platform: "node", disks: [{ name: "data", mountTo: "/data", size: "2.5" }, { name: "bad", mountTo: "/bad", size: "large" }] }),
    );
    const detected = detectStack(dir, "sample");
    assert.deepEqual(detected.disks, [
      { name: "data", mountTo: "/data", size: "2.5" },
      { name: "bad", mountTo: "/bad" },
    ]);
    const plan = planDiskMounts(detected.disks ?? [], []);
    assert.deepEqual(plan.creates, [{ name: "data", size: "2.5", mountTo: "/data" }]);
    assert.deepEqual(plan.blocked, [{ name: "bad", mountTo: "/bad" }]);
    assert.match(formatDiskCard(plan), /اندازه 2\.5/);
    assert.match(formatDiskCard(plan), /bad → \/bad/);
    assert.equal(
      createsAreAuthorized(plan.creates, [{ name: "data", size: "1", mountTo: "/data" }]),
      false,
    );
    assert.equal(
      createsAreAuthorized(plan.creates, [{ name: "data", size: "2.5", mountTo: "/data" }]),
      true,
    );
    assert.equal(mountsAreAuthorized(plan.releaseDisks, [{ name: "data", mountTo: "/data" }]), false);
    const decision = decideApproval({
      tool: "liara_deploy",
      params: { app: "sample", diskCreates: plan.creates },
      declaredRisk: "medium",
      policy: "auto",
    });
    assert.equal(decision.risk, "high");
    assert.equal(decision.requiresApproval, true);
    assert.equal(decision.automatic, false);
    assert.equal(cardShowsDiskPlan(plan.lines, plan.releaseDisks, plan.creates), false);
    const shown = plan.lines.filter((line) => line.action === "create");
    assert.equal(cardShowsDiskPlan(shown, shown.map((line) => ({ name: line.name, mountTo: line.mountTo })), plan.creates), true);
    assert.equal(cardShowsDiskPlan([], plan.releaseDisks, plan.creates), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
