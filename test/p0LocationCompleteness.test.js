import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isStepComplete,
  currentStepIncomplete,
  hasEnabledContinue,
  locationTypeaheadCommitted,
  shouldAutoAdvance,
} from "../src/layers/steppedForm.js";
import { decideWizardPlan } from "../src/layers/wizardLoop.js";
import {
  discoverCustomControlsFromSnap,
  discoverScreeningControlsFromSnap,
} from "../src/fillCustomControls.js";
import { RecoveryTracker } from "../src/recoveryTracker.js";

const SCREENING = (filled) => [
  { widgetType: "yesno", mappedTo: "workauthorization", label: "authorized to work", filled },
  { widgetType: "yesno", mappedTo: "visasponsorship", label: "visa sponsorship", filled },
  { widgetType: "radio", mappedTo: "remotepreference", label: "working remotely", filled },
  { widgetType: "yesno", mappedTo: "willingtorelocate", label: "willing to relocate", filled },
];

/**
 * Live apply:180-shaped snap after the scanDom fix: screening radios ARE emitted
 * as customControls (filled:false until answered). WaaS Continue is always enabled.
 */
function waasLocationSnap({ cityFilled = true, screeningFilled = false, ...overrides } = {}) {
  return {
    url: "https://www.workatastartup.com/application/location",
    fieldCount: 9,
    fields: [
      { type: "radio", label: "Yes", filled: false },
      { type: "radio", label: "No", filled: false },
      { type: "radio", label: "I'm open to working remotely", filled: false },
      { type: "combobox", label: "What city do you live in? *", filled: false },
    ],
    customControls: [
      {
        widgetType: "typeahead",
        mappedTo: "location",
        label: "What city do you live in?",
        filled: cityFilled,
        text: cityFilled ? "London, UK" : "",
      },
      ...SCREENING(screeningFilled),
    ],
    pageText:
      "What city do you live in? Are you legally authorized to work in the United States? " +
      "Do you require visa sponsorship to work legally? Are you open to working remotely? " +
      "Are you willing to relocate?",
    continueCount: 1,
    continueCandidates: [{ text: "Continue", score: 105, disabled: false }],
    ...overrides,
  };
}

describe("P0 isStepComplete (WaaS Location)", () => {
  it("is INCOMPLETE while screening radios are unanswered, even with enabled Continue + city", () => {
    const snap = waasLocationSnap({ cityFilled: true, screeningFilled: false });
    assert.equal(hasEnabledContinue(snap), true);
    assert.equal(locationTypeaheadCommitted(snap, { filled: [{ type: "location" }] }), true);
    assert.equal(isStepComplete(snap, { filled: [{ type: "location" }] }), false);
    assert.equal(currentStepIncomplete(snap, { filled: [{ type: "location" }] }), true);
    assert.equal(shouldAutoAdvance(snap, { filled: [{ type: "location" }] }), false);
  });

  it("is COMPLETE only after both city and screening are answered", () => {
    const snap = waasLocationSnap({ cityFilled: true, screeningFilled: true });
    assert.equal(isStepComplete(snap, { filled: [{ type: "location" }] }), true);
    assert.equal(shouldAutoAdvance(snap, { filled: [{ type: "location" }] }), true);
  });

  it("wizard fills missing screening before advancing", () => {
    const decided = decideWizardPlan(
      waasLocationSnap({ screeningFilled: false }),
      { filled: [{ type: "location" }] },
      [],
      {},
    );
    assert.equal(decided?.situation, "fill_missing_required");
    assert.equal(decided?.plan?.type, "smart_fill");
  });

  it("wizard advances once screening is answered", () => {
    const decided = decideWizardPlan(
      waasLocationSnap({ screeningFilled: true }),
      { filled: [{ type: "location" }] },
      [],
      {},
    );
    assert.equal(decided?.situation, "advance");
    assert.equal(decided?.plan?.type, "click_continue");
  });
});

describe("P0 RecoveryTracker advance", () => {
  it("escalates to advance when smart_fill loops on a complete step", () => {
    const tracker = new RecoveryTracker({ maxPerAction: 3 });
    const fp = "location-hash";
    tracker.record("smart_fill", fp);
    tracker.record("smart_fill", fp);
    tracker.record("smart_fill", fp);
    assert.equal(
      tracker.escalate("smart_fill", fp, { stepComplete: true, continueEnabled: true }),
      "advance",
    );
  });

  it("still escalates to stagehand when step incomplete", () => {
    const tracker = new RecoveryTracker({ maxPerAction: 3 });
    const fp = "form-hash";
    tracker.record("smart_fill", fp);
    tracker.record("smart_fill", fp);
    tracker.record("smart_fill", fp);
    assert.equal(
      tracker.escalate("smart_fill", fp, { stepComplete: false, continueEnabled: false }),
      "stagehand",
    );
  });
});

describe("P0 screening discovery merge", () => {
  it("discovers screening radios even when city typeahead is still unfilled in snap", () => {
    const snap = waasLocationSnap({ cityFilled: false, screeningFilled: false });
    const controls = discoverCustomControlsFromSnap(snap);
    const mapped = new Set(controls.map((c) => c.mappedTo));
    assert.ok(mapped.has("location"), "keeps city");
    assert.ok(mapped.has("workauthorization") || mapped.has("visasponsorship"), "adds screening");
    assert.ok(controls.length >= 3, `expected multiple targets, got ${controls.length}`);
  });

  it("heuristic screening controls carry a matchable question label (not the mappedTo)", () => {
    // Snap without screening in customControls → heuristic must synthesize them
    // with a real question phrase so the fillers can locate the radiogroup.
    const snap = waasLocationSnap({ cityFilled: false, screeningFilled: false, customControls: [] });
    const controls = discoverScreeningControlsFromSnap(snap);
    const visa = controls.find((c) => c.mappedTo === "visasponsorship");
    assert.ok(visa, "expected visasponsorship");
    assert.notEqual(visa.questionLabel, "visasponsorship");
    assert.match(String(visa.questionLabel), /sponsor/i);
  });
});
