import assert from "node:assert/strict";
import { test } from "node:test";
import { isLoopbackAddress } from "../src/diagnose/resolver.js";

test("آدرس loopback و نگاشت IPv4 رد می‌شود", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("127.154.0.12"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("8.8.8.8"), false);
});
