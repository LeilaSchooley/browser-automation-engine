import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runAutomationAgent } from "../src/layers/automationAgent.js";
import { inspectPage } from "../src/layers/formDiscovery.js";
import {
  attemptFinalRecovery,
  attemptSemanticRecovery,
} from "../src/layers/semanticRecovery.js";
import { withFixturePage } from "./helpers/fixtures.js";
import { quietLog } from "./helpers/log.js";
import { initTestRuntime } from "./helpers/runtime.js";

describe("agent semantic recovery", () => {
  it("attemptSemanticRecovery clears chained upsell modals", async () => {
    initTestRuntime();
    await withFixturePage("upsell-chain", async (page) => {
      const snap = await inspectPage(page);
      const recovery = await attemptSemanticRecovery(page, snap, {
        verdict: {
          progressed: false,
          reason: "another upsell modal still blocking",
          recovery: "dismiss_overlay",
        },
        history: [{ action: "dismiss_overlay", ok: true, progress: false, progressSource: "validator" }],
        lastPlan: { type: "dismiss_overlay" },
        log: quietLog(),
        url: "https://www.jobleads.com/us/job/example",
        fillResult: { filled: [] },
        context: {},
      });
      assert.equal(recovery.ok, true);
      const after = recovery.snap || (await inspectPage(page));
      assert.ok(after.fieldCount >= 2);
    });
  });

  it("attemptFinalRecovery uses end-state assessor before manual handoff", async () => {
    initTestRuntime({
      assessEndState: async () => ({
        action: "dismiss_overlay",
        reason: "survey modal still blocking",
      }),
    });

    await withFixturePage("generic-survey-modal", async (page) => {
      const snap = await inspectPage(page);
      const result = await attemptFinalRecovery(page, snap, [], { filled: [] }, {}, quietLog(), {
        url: "https://applyco.example/job",
      });
      assert.equal(result.recovered, true);
      const after = await inspectPage(page);
      assert.ok(after.fieldCount >= 2);
    });
  });

  it("agent loop invokes validator and can reach form on upsell chain", async () => {
    let validatorCalls = 0;
    initTestRuntime({
      settings: { agent_max_steps: 6, agent_ai: false },
      validateAction: async ({ snapAfter }) => {
        validatorCalls += 1;
        if ((snapAfter?.fieldCount || 0) >= 2) {
          return { progressed: true, reason: "application form visible", source: "validator" };
        }
        return {
          progressed: false,
          reason: "blocker still visible",
          recovery: "dismiss_overlay",
          source: "validator",
        };
      },
    });

    await withFixturePage("upsell-chain", async (page) => {
      const result = await runAutomationAgent(page, { job: { title: "Engineer", company: "ACME" } }, quietLog(), {
        url: "https://www.jobleads.com/us/job/example",
      });
      assert.ok(validatorCalls >= 1);
      const finalSnap = result.snap || (await inspectPage(page));
      assert.ok(finalSnap.fieldCount >= 2);
    });
  });
});
