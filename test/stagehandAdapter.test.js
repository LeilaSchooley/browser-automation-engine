import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getSettings } from "../src/runtime.js";
import { initTestRuntime } from "./helpers/runtime.js";
import { canUseStagehand } from "../src/layers/stagehandAdapter.js";

describe("stagehandAdapter", () => {
  it("attemptStagehandFill returns disabled when stagehand_enabled is false", async () => {
    initTestRuntime({ settings: { stagehand_enabled: false } });
    const { attemptStagehandFill } = await import("../src/layers/stagehandAdapter.js");
    const result = await attemptStagehandFill({}, {}, { instruction: "test" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "disabled");
  });

  it("allows adspower and multilogin when cdp url is present", () => {
    initTestRuntime({ settings: { stagehand_enabled: true } });
    assert.equal(canUseStagehand({ browserProvider: "adspower", browserCdpUrl: "ws://127.0.0.1:9222/devtools/browser/abc" }).ok, true);
    assert.equal(canUseStagehand({ browserProvider: "multilogin", browserCdpUrl: "http://127.0.0.1:9222" }).ok, true);
  });

  it("canUseStagehand requires cdp url for playwright", () => {
    initTestRuntime({ settings: { stagehand_enabled: true } });
    assert.equal(canUseStagehand({ browserProvider: "playwright" }).reason, "no_cdp_url");
    assert.equal(canUseStagehand({ browserProvider: "playwright", browserCdpUrl: "ws://127.0.0.1:9222" }).ok, true);
  });

  it("settings expose stagehand defaults", () => {
    initTestRuntime({});
    const s = getSettings();
    assert.equal(s.stagehand_enabled, false);
    assert.equal(s.stagehand_cache_enabled, true);
  });
});
