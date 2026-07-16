import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createAgentCore,
  defineProfile,
} from "@leilaschooley/browser-automation-engine/core";
import {
  createEngine,
  createProfileEngine,
  LEGACY_PROFILE,
} from "@leilaschooley/browser-automation-engine";
import {
  createApplyEngine,
  profile as applyProfile,
} from "@leilaschooley/browser-automation-engine/profiles/apply";
import {
  createDirectoryEngine,
  profile as directoryProfile,
} from "@leilaschooley/browser-automation-engine/profiles/directory";
import {
  createGenericEngine,
  profile as genericProfile,
} from "@leilaschooley/browser-automation-engine/profiles/generic";
import { resolveProfile } from "@leilaschooley/browser-automation-engine/profiles";

describe("workflow profiles", () => {
  it("preserves legacy behavior when no profile is supplied", () => {
    const engine = createEngine();
    assert.equal(engine.profile, LEGACY_PROFILE);
    assert.equal(engine.settings.listing_mode, true);
    assert.equal(engine.settings.smart_fill_profile, undefined);
  });

  it("applies domain defaults before caller overrides", () => {
    const engine = createApplyEngine({
      settings: { auto_submit: true },
    });

    assert.equal(engine.profile.name, "apply");
    assert.equal(engine.settings.listing_mode, false);
    assert.equal(engine.settings.smart_fill_profile, "apply");
    assert.equal(engine.settings.auto_submit, true);
    assert.ok(engine.capabilities.includes("resume-upload"));
  });

  it("configures directory and generic profiles independently", () => {
    const directory = createDirectoryEngine();
    assert.equal(directory.profile, directoryProfile);
    assert.equal(directory.settings.listing_mode, true);
    assert.equal(directory.settings.smart_fill_profile, "directory");
    assert.equal(directory.settings.workflow_intent, "submit_listing");

    const generic = createGenericEngine();
    assert.equal(generic.profile, genericProfile);
    assert.equal(generic.settings.listing_mode, false);
    assert.equal(generic.settings.smart_fill_profile, "all");
    assert.equal(generic.settings.auto_signup_enabled, false);
  });

  it("accepts named and custom profiles", () => {
    assert.equal(resolveProfile("apply"), applyProfile);
    assert.throws(() => resolveProfile("missing"), /unknown browser engine profile/);

    const custom = defineProfile({
      name: "traffic",
      entryLabel: "Visit",
      intent: "drive_traffic",
      settings: {
        listing_mode: false,
        auto_signup_enabled: false,
      },
      capabilities: ["navigation", "dwell"],
    });
    const engine = createProfileEngine(custom, {
      settings: { agent_max_steps: 5 },
    });
    assert.equal(engine.profile.name, "traffic");
    assert.equal(engine.settings.agent_max_steps, 5);
    assert.deepEqual(engine.capabilities, ["navigation", "dwell"]);

    const agent = engine.createAgent({
      observe: async () => ({}),
      plan: async () => null,
      execute: async () => ({ ok: true }),
    });
    assert.equal(agent.profile, custom);
  });
});

describe("domain-neutral agent core", () => {
  it("runs injected observe → classify → plan → execute hooks", async () => {
    let value = 0;
    const events = [];
    const agent = createAgentCore({
      profile: genericProfile,
      observe: async () => ({ value }),
      classify: async (state) => ({
        done: state.value >= 3,
      }),
      plan: async ({ classification }) =>
        classification.done ? null : { type: "increment" },
      execute: async ({ action }) => {
        assert.equal(action.type, "increment");
        value += 1;
        return {
          ok: true,
          progress: true,
          state: { value },
        };
      },
      isDone: async ({ classification }) => classification?.done === true,
      onEvent: async (event) => events.push(event.type),
    });

    const result = await agent.run({ maxSteps: 8 });
    assert.equal(result.status, "done");
    assert.equal(result.state.value, 3);
    assert.equal(result.steps, 3);
    assert.equal(result.history.every((entry) => entry.ok && entry.progress), true);
    assert.equal(events.filter((event) => event === "action_finished").length, 3);
  });

  it("supports cancellation and no-action terminal states", async () => {
    const stoppedAgent = createAgentCore({
      observe: async () => ({}),
      plan: async () => ({ type: "noop" }),
      execute: async () => ({ ok: true }),
    });
    const stopped = await stoppedAgent.run({ shouldStop: () => true });
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.steps, 0);

    const idleAgent = createAgentCore({
      observe: async () => ({ ready: false }),
      plan: async () => null,
      execute: async () => ({ ok: true }),
    });
    const idle = await idleAgent.run();
    assert.equal(idle.status, "no_action");
    assert.equal(idle.steps, 0);
  });

  it("validates required adapter hooks", () => {
    assert.throws(() => createAgentCore({}), /requires a observe/);
  });
});
