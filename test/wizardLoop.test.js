import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  currentStepIncomplete,
  shouldAutoAdvance,
  wizardAdvanced,
  planAfterContinue,
} from "../src/layers/steppedForm.js";
import {
  observeWizard,
  assessWizard,
  planWizardAction,
  decideWizardPlan,
  planAfterWizardContinue,
} from "../src/layers/wizardLoop.js";

describe("wizard incomplete detection (location / typeahead)", () => {
  const locationStep = {
    url: "https://account.ycombinator.com/application/location",
    fieldCount: 1,
    fields: [
      {
        type: "combobox",
        widgetType: "combobox",
        label: "What city do you live in?",
        filled: false,
      },
    ],
    customControls: [
      {
        widgetType: "typeahead",
        mappedTo: "location",
        label: "What city do you live in?",
        filled: true,
        text: "London, UK",
      },
      // Scanner duplicates
      {
        widgetType: "typeahead",
        mappedTo: "location",
        label: "What city do you live in?",
        filled: true,
        text: "London, UK",
      },
    ],
    continueCount: 1,
    continueCandidates: [{ text: "Continue", score: 90, disabled: false }],
  };

  it("does not treat filled city typeahead as incomplete when combobox field is empty", () => {
    assert.equal(currentStepIncomplete(locationStep, { filled: [{ type: "location" }] }), false);
    assert.equal(shouldAutoAdvance(locationStep, { filled: [{ type: "location" }] }), true);
  });

  it("wizard SM chooses advance when step is complete", () => {
    const decided = decideWizardPlan(locationStep, { filled: [{ type: "location" }] }, [], {});
    assert.equal(decided?.situation, "advance");
    assert.equal(decided?.plan?.type, "click_continue");
  });
});

describe("wizard advance / stuck recovery", () => {
  const before = {
    url: "https://account.ycombinator.com/application/location",
    fieldCount: 0,
    fields: [],
    customControls: [
      { widgetType: "typeahead", mappedTo: "location", label: "city", filled: true },
    ],
    continueCount: 1,
    continueCandidates: [{ text: "Continue", disabled: false }],
  };
  const sameStep = { ...before };
  const nextStep = {
    url: "https://account.ycombinator.com/application/work-authorization",
    fieldCount: 0,
    fields: [],
    customControls: [
      { widgetType: "radio", mappedTo: "workauthorization", label: "authorized", filled: false },
    ],
    continueCount: 1,
    continueCandidates: [{ text: "Continue", disabled: false }],
  };

  it("detects wizardAdvanced across URL path change", () => {
    assert.equal(wizardAdvanced(before, sameStep), false);
    assert.equal(wizardAdvanced(before, nextStep), true);
  });

  it("planAfterContinue fills the new incomplete step", () => {
    const plan = planAfterContinue(before, nextStep, { filled: [] });
    assert.equal(plan?.type, "smart_fill");
  });

  it("stuck Continue → commit_step, then Stagehand, then handoff", () => {
    const first = planAfterWizardContinue(before, sameStep, { filled: [] }, { stuckCount: 0 });
    assert.equal(first.stuck, true);
    assert.equal(first.plan?.type, "commit_step");

    const second = planAfterWizardContinue(before, sameStep, { filled: [] }, {
      stuckCount: 1,
      context: { openaiApiKey: "sk-test", stagehandApiKey: "sh-test" },
    });
    // Without real Stagehand keys canUseStagehand may be false → still commit.
    assert.ok(["commit_step", "stagehand_act"].includes(second.plan?.type));

    const third = planAfterWizardContinue(before, sameStep, { filled: [] }, { stuckCount: 2 });
    assert.ok(["stagehand_act", "commit_step", "wait_user"].includes(third.plan?.type));

    const fourth = planAfterWizardContinue(before, sameStep, { filled: [] }, { stuckCount: 3 });
    assert.equal(fourth.plan?.type, "wait_user");
  });

  it("assess maps fill stall + continue enabled to commit", () => {
    const obs = observeWizard(
      before,
      { filled: [] },
      [
        { action: "smart_fill", progress: false },
        { action: "smart_fill", progress: false },
        { action: "smart_fill", progress: false },
      ],
      {},
    );
    // before is complete (customs filled) — readyToAdvance
    const assessment = assessWizard(obs);
    assert.equal(assessment.situation, "advance");
    assert.equal(planWizardAction(assessment)?.type, "click_continue");
  });
});

describe("wizard respects WaaS serverErrors (no wrong commit_step)", () => {
  const roleStep = {
    url: "https://www.workatastartup.com/application/role",
    fieldCount: 3,
    fields: [],
    customControls: [
      { widgetType: "radio", mappedTo: "jobfunction", label: "job function", filled: false },
      { widgetType: "yesno", mappedTo: "fulltimestudent", label: "student", filled: false },
    ],
    continueCount: 1,
    continueCandidates: [{ text: "Continue", disabled: false }],
    waasValidation: {
      available: true,
      missing: ["role", "in_school", "job_type"],
      visibleRequiredCount: 2,
      serverErrors: { role: ["is missing"], in_school: ["is missing"], job_type: ["is missing"] },
    },
  };

  it("serverErrors → smart_fill, never commit_step", () => {
    const decided = decideWizardPlan(roleStep, { filled: [] }, [], {});
    assert.equal(decided?.plan?.type, "smart_fill");
    assert.match(decided?.reason || "", /serverErrors|Required/i);
  });

  it("stuck Continue on Role with serverErrors → smart_fill (not commit)", () => {
    const first = planAfterWizardContinue(roleStep, roleStep, { filled: [] }, { stuckCount: 0 });
    assert.equal(first.stuck, true);
    assert.equal(first.plan?.type, "smart_fill");
  });

  it("fill stall + Continue enabled on Role still fills when serverErrors open", () => {
    const obs = observeWizard(
      roleStep,
      { filled: [] },
      [
        { action: "smart_fill", progress: false },
        { action: "smart_fill", progress: false },
        { action: "smart_fill", progress: false },
      ],
      {},
    );
    assert.equal(obs.serverMissing, true);
    assert.equal(obs.canCommitTypeahead, false);
    const assessment = assessWizard(obs);
    assert.equal(assessment.situation, "fill_missing_required");
    assert.equal(planWizardAction(assessment)?.type, "smart_fill");
  });
});
