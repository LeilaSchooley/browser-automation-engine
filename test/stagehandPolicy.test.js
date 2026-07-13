import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initTestRuntime } from "./helpers/runtime.js";
import {
  shouldPreferStagehand,
  buildStagehandInstruction,
  buildStagehandPlan,
} from "../src/layers/stagehandPolicy.js";
import { decideWithActionBrain } from "../src/layers/actionBrain.js";

describe("stagehandPolicy", () => {
  const ashbySnap = {
    url: "https://jobs.ashbyhq.com/ditto",
    pageText: "Open Positions",
    passwordFieldCount: 0,
    fileInputCount: 0,
    entryCount: 0,
    fieldCount: 4,
    fields: [
      { name: "departmentId", label: "Department", type: "select-one" },
      { name: "employmentType", label: "Employment Type", type: "select-one" },
      { name: "locationId", label: "Location", type: "select-one" },
      { name: "workplaceType", label: "Location Type", type: "select-one" },
    ],
  };

  it("prefers stagehand on Ashby job board when CDP is available", () => {
    initTestRuntime({ settings: { stagehand_enabled: true, agent_ai: true } });
    const classification = { step: "entry", confidence: "high", reason: "job board" };
    const context = { browserProvider: "adspower", browserCdpUrl: "ws://127.0.0.1:9222/x" };
    assert.equal(shouldPreferStagehand(ashbySnap, classification, [], context), true);
  });

  it("skips stagehand when disabled or no cdp", () => {
    initTestRuntime({ settings: { stagehand_enabled: false } });
    assert.equal(shouldPreferStagehand(ashbySnap, { step: "entry" }, [], {}), false);
    initTestRuntime({ settings: { stagehand_enabled: true } });
    assert.equal(shouldPreferStagehand(ashbySnap, { step: "entry" }, [], { browserProvider: "adspower" }), false);
  });

  it("builds job-board navigation instruction with job title", () => {
    const instruction = buildStagehandInstruction(
      ashbySnap,
      { step: "entry" },
      [],
      { job: { title: "Senior Engineer", company: "Ditto" } },
    );
    assert.match(instruction, /Senior Engineer/i);
    assert.match(instruction, /Ditto/i);
    assert.match(instruction, /filter dropdowns/i);
  });

  it("buildStagehandPlan returns stagehand_act", () => {
    const plan = buildStagehandPlan(ashbySnap, { step: "entry", reason: "job board" }, [], {
      job: { title: "Engineer" },
      browserProvider: "adspower",
      browserCdpUrl: "ws://127.0.0.1:9222/x",
    });
    assert.equal(plan.type, "stagehand_act");
    assert.ok(plan.instruction);
    assert.equal(plan.source, "stagehand-policy");
  });

  it("action brain routes job board to stagehand-primary", async () => {
    initTestRuntime({
      settings: {
        stagehand_enabled: true,
        agent_ai: true,
        action_brain_mode: "primary",
        deterministic_first: true,
      },
      planNextAction: async () => ({ type: "click_apply", reason: "llm should not run" }),
    });
    const { plan, decision } = await decideWithActionBrain(
      ashbySnap,
      { filled: [] },
      [],
      {
        browserProvider: "adspower",
        browserCdpUrl: "ws://127.0.0.1:9222/x",
        job: { title: "Platform Engineer", company: "Ditto" },
      },
    );
    assert.equal(plan.type, "stagehand_act");
    assert.equal(decision.path, "action-catalog");
  });
});
