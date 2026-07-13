import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AgentPlanSchema,
  ValidatorResponseSchema,
  parseJsonFromLlm,
} from "../src/ai/contracts.js";

describe("ai/contracts", () => {
  it("parseJsonFromLlm strips markdown fences", () => {
    const data = parseJsonFromLlm(
      '```json\n{"action":"click","reason":"go"}\n```',
      AgentPlanSchema,
    );
    assert.equal(data?.action, "click");
    assert.equal(data?.reason, "go");
  });

  it("ValidatorResponseSchema accepts recovery actions", () => {
    const data = parseJsonFromLlm(
      '{"progressed": false, "reason": "stuck", "recovery": "click_modal"}',
      ValidatorResponseSchema,
    );
    assert.equal(data?.progressed, false);
    assert.equal(data?.recovery, "click_modal");
  });

  it("rejects invalid agent plan payloads", () => {
    assert.equal(parseJsonFromLlm('{"action": 123}', AgentPlanSchema), null);
  });
});
