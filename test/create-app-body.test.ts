import assert from "node:assert/strict";
import { test } from "node:test";
import { CREATE_APP_PATH, createAppBody } from "../src/liara/create-app.js";
import { EP } from "../src/liara/endpoints.js";
import { explainPlanError } from "../src/liara/plan-choice.js";

/**
 * شکل CLI قبل از JSON.stringify، از create.js:37-44.
 * کلیدهای undefined در بدنهٔ ارسالی نمی‌مانند.
 */
function cliWireBody(input: {
  name: string;
  planID: string;
  platform: string;
  bundlePlanID: string;
  network: string | undefined;
  readOnlyRootFilesystem: boolean | undefined;
}): Record<string, unknown> {
  return JSON.parse(JSON.stringify({
    name: input.name,
    planID: input.planID,
    platform: input.platform,
    bundlePlanID: input.bundlePlanID,
    network: input.network,
    readOnlyRootFilesystem: input.readOnlyRootFilesystem,
  })) as Record<string, unknown>;
}

test("بدنه و مسیر ساخت اپ با create.js هم‌شکل است", () => {
  assert.equal(CREATE_APP_PATH, "/v1/projects/");
  assert.equal(EP.createProject, CREATE_APP_PATH);
  assert.equal(EP.listProjects, "/v1/projects");

  const withNetwork = createAppBody({
    name: "demo",
    planID: "small-g2",
    platform: "node",
    bundlePlanID: "basic",
    networkId: "net-id",
  });
  assert.deepEqual(Object.keys(withNetwork), [
    "name",
    "planID",
    "platform",
    "bundlePlanID",
    "network",
    "readOnlyRootFilesystem",
  ]);
  assert.equal("region" in withNetwork, false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(withNetwork)),
    cliWireBody({
      name: "demo",
      planID: "small-g2",
      platform: "node",
      bundlePlanID: "basic",
      network: "net-id",
      readOnlyRootFilesystem: undefined,
    }),
  );

  const readOnly = createAppBody({
    name: "demo",
    planID: "small-g2",
    platform: "node",
    bundlePlanID: "basic",
    networkId: null,
    readOnlyRootFilesystem: true,
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(readOnly)),
    cliWireBody({
      name: "demo",
      planID: "small-g2",
      platform: "node",
      bundlePlanID: "basic",
      network: undefined,
      readOnlyRootFilesystem: true,
    }),
  );
  assert.equal(JSON.parse(JSON.stringify(readOnly)).network, undefined);
});

test("پیام g2_plan_unavailable پلن را برمی‌دارد ولی ایراد را به درخواست هم نسبت می‌دهد", () => {
  const text = explainPlanError("small-g2", "g2_plan_unavailable");
  assert.match(text, /شکل درخواست/);
  assert.match(text, /نه از خود پلن/);
  assert.match(text, /برداشته شد/);
  assert.match(text, /خودکار انجام نشد/);
});
