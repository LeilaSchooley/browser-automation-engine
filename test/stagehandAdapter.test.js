import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getSettings } from "../src/runtime.js";
import { initTestRuntime } from "./helpers/runtime.js";

describe("stagehandAdapter", () => {
  it("attemptStagehandFill returns disabled when stagehand_enabled is false", async () => {
    initTestRuntime({ settings: { stagehand_enabled: false } });
    const { attemptStagehandFill } = await import("../src/layers/stagehandAdapter.js");
    const result = await attemptStagehandFill({}, {}, { instruction: "test" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "disabled");
  });

  it("settings expose stagehand defaults", () => {
    initTestRuntime({});
    const s = getSettings();
    assert.equal(s.stagehand_enabled, false);
    assert.equal(s.stagehand_cache_enabled, true);
  });
});
