import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mapLabelToMapped,
  isCommittedValue,
  PICKER_CONFIRM_PATTERNS,
  PLACEHOLDER_RE,
  MIN_CONTROL_SKILL_SUCCESS,
} from "../src/primitives/controlPatterns.js";
import { buildDeterministicPlan, shouldInvokeLlm, isDeterministicState, smartFillStalledOnStep } from "../src/layers/deterministicPolicy.js";
import {
  serializeLabelRules,
  pickClosestSalaryOptionInBrowser,
} from "../src/primitives/browserControlPatterns.js";
import { pickClosestSalaryOption } from "../src/salaryExpectation.js";
import { refreshSnapIfNeeded, computePageDiff, isMinorPerceptionDiff } from "../src/layers/pagePerception.js";
import { initTestRuntime } from "./helpers/runtime.js";

describe("controlPatterns", () => {
  it("mapLabelToMapped resolves salary and location", () => {
    assert.equal(mapLabelToMapped("Salary expectations")?.mappedTo, "salary");
    assert.equal(mapLabelToMapped("Where are you based?")?.mappedTo, "location");
  });

  it("isCommittedValue rejects placeholders", () => {
    assert.equal(isCommittedValue("?"), false);
    assert.equal(isCommittedValue("USD 60,000 - 80,000", "salary"), true);
  });

  it("PICKER_CONFIRM_PATTERNS includes Save", () => {
    assert.ok(PICKER_CONFIRM_PATTERNS.some((p) => p.test("Save")));
  });

  it("PLACEHOLDER_RE matches question mark", () => {
    assert.ok(PLACEHOLDER_RE.test("?"));
  });

  it("MIN_CONTROL_SKILL_SUCCESS is 2", () => {
    assert.equal(MIN_CONTROL_SKILL_SUCCESS, 2);
  });

  it("serializeLabelRules matches mapLabelToMapped", () => {
    const rules = serializeLabelRules();
    assert.ok(rules.some((r) => r.mappedTo === "salary"));
    assert.equal(mapLabelToMapped("Salary expectations")?.mappedTo, "salary");
    assert.equal(mapLabelToMapped("Desired job title")?.mappedTo, "desiredtitle");
  });

  it("browser salary picker matches Node pickClosestSalaryOption", () => {
    const opts = [
      { value: "a", text: "$50,000 - $60,000" },
      { value: "b", text: "$90,000 - $110,000" },
      { value: "c", text: "$120,000 - $150,000" },
    ];
    const target = "$100,000";
    assert.equal(
      pickClosestSalaryOptionInBrowser(opts, target)?.value,
      pickClosestSalaryOption(opts, target)?.value,
    );
  });
});

describe("deterministicPolicy", () => {
  it("buildDeterministicPlan for preferences gate", () => {
    const snap = {
      applyModalTitle: "Tell us about yourself",
      pageText: "salary expectations location desired job title",
      customControls: [{ mappedTo: "salary", filled: false }],
      customControlCount: 1,
      fieldCount: 0,
    };
    const plan = buildDeterministicPlan(
      { step: "form", reason: "preferences gate", confidence: "high" },
      snap,
      { uiPhase: "picker_open", pendingCommits: ["Salary not committed"] },
    );
    assert.equal(plan?.type, "smart_fill");
    assert.equal(plan?.source, "deterministic-policy");
  });

  it("shouldInvokeLlm for ambiguous step", () => {
    assert.equal(shouldInvokeLlm({ step: "ambiguous", confidence: "low" }, {}), true);
  });

  it("isDeterministicState for consent", () => {
    const snap = {
      cookieBanner: true,
      structuralCookieBanner: true,
      cookieCandidates: [{ text: "Accept all cookies", score: 90 }],
      pageText: "cookies",
      fieldCount: 0,
    };
    assert.ok(isDeterministicState({ step: "consent", confidence: "high" }, snap, null, []));
  });

  it("isDeterministicState yields to LLM after repeated smart_fill stalls", () => {
    const snap = { applyModalTitle: "Tell us about yourself", fields: [{ label: "Salary expectations", filled: false }] };
    const history = [
      { action: "smart_fill", progress: false, applyStep: "form" },
      { action: "smart_fill", progress: false, applyStep: "form" },
    ];
    assert.equal(
      isDeterministicState({ step: "form", confidence: "high" }, snap, null, history),
      false,
    );
    assert.equal(
      shouldInvokeLlm({ step: "form", confidence: "high" }, snap, null, history),
      true,
    );
    assert.equal(smartFillStalledOnStep(history, { step: "form" }), true);
  });
});

describe("pagePerception", () => {
  it("computePageDiff detects picker toggle", () => {
    const before = { refs: [{ role: "button", label: "Save" }], pickerOpen: true };
    const after = { refs: [{ role: "button", label: "Save" }], pickerOpen: false };
    const diff = computePageDiff(before, after);
    assert.ok(diff.pickerToggled);
    assert.ok(diff.changed);
  });

  it("isMinorPerceptionDiff detects stable page", () => {
    assert.ok(isMinorPerceptionDiff({ changed: false, pickerToggled: false, addedRefs: 0, removedRefs: 0 }));
    assert.ok(!isMinorPerceptionDiff({ changed: true, pickerToggled: false, addedRefs: 1, removedRefs: 0 }));
  });
});
