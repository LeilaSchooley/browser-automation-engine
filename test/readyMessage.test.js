import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildReadyMessage } from "../src/layers/runPipeline.js";
import { isPageUnloaded } from "../src/layers/pageReady.js";

describe("buildReadyMessage", () => {
  it("reports filled fields after agent steps", () => {
    const msg = buildReadyMessage({
      fillResult: { filled: [{}, {}, {}] },
      snap: { fieldCount: 5, pageKind: "form" },
      prep: { actions: [] },
      agentSteps: 4,
    });
    assert.match(msg, /Filled 3 field/);
    assert.match(msg, /4 agent steps/);
  });

  it("reports visible fields when none matched", () => {
    const msg = buildReadyMessage({
      fillResult: { filled: [] },
      snap: { fieldCount: 4, pageKind: "form" },
      prep: { actions: [] },
      agentSteps: 2,
    });
    assert.match(msg, /4 field\(s\) visible but auto-fill matched none/);
  });

  it("reports listing click success from prep", () => {
    const msg = buildReadyMessage({
      fillResult: { filled: [] },
      snap: {
        fieldCount: 0,
        pageKind: "listing",
        entryCount: 1,
        entryCandidates: [{ text: "I'm interested" }],
      },
      prep: { actions: ["entry"] },
      agentSteps: 1,
    });
    assert.match(msg, /Clicked "I'm interested"/);
  });

  it("reports listing when agent could not click entry", () => {
    const msg = buildReadyMessage({
      fillResult: { filled: [] },
      snap: {
        fieldCount: 0,
        pageKind: "listing",
        entryCount: 1,
        entryCandidates: [{ text: "Apply" }],
      },
      prep: { actions: [] },
      agentSteps: 1,
    });
    assert.match(msg, /could not click it/);
  });

  it("reports modal and continue fallbacks", () => {
    assert.match(
      buildReadyMessage({
        fillResult: { filled: [] },
        snap: { fieldCount: 0, pageKind: "modal", entryCount: 0, continueCount: 0 },
        prep: { actions: [] },
        agentSteps: 2,
      }),
      /Modal open/,
    );
    assert.match(
      buildReadyMessage({
        fillResult: { filled: [] },
        snap: { fieldCount: 0, pageKind: "content", entryCount: 0, continueCount: 1 },
        prep: { actions: [] },
        agentSteps: 2,
      }),
      /Continue\/Next/,
    );
  });

  it("uses generic finished message as last resort", () => {
    const msg = buildReadyMessage({
      fillResult: { filled: [] },
      snap: { fieldCount: 0, pageKind: "unknown", entryCount: 0, continueCount: 0 },
      prep: { actions: [] },
      agentSteps: 3,
    });
    assert.match(msg, /Agent finished/);
  });
});

describe("isPageUnloaded", () => {
  it("treats empty unknown pages as unloaded", () => {
    assert.equal(
      isPageUnloaded({
        pageKind: "unknown",
        fieldCount: 0,
        title: "",
        bodyTextLength: 0,
        entryCount: 0,
        cookieBanner: false,
        hasApplyModal: false,
        modalStepCount: 0,
      }),
      true,
    );
  });

  it("treats listing / form / modal / cookie surfaces as loaded", () => {
    assert.equal(isPageUnloaded({ pageKind: "listing", fieldCount: 0, title: "Job", entryCount: 1 }), false);
    assert.equal(isPageUnloaded({ pageKind: "form", fieldCount: 3, title: "Apply" }), false);
    assert.equal(isPageUnloaded({ pageKind: "unknown", hasApplyModal: true, title: "" }), false);
    assert.equal(isPageUnloaded({ pageKind: "unknown", cookieBanner: true, title: "" }), false);
    assert.equal(
      isPageUnloaded({ pageKind: "unknown", fieldCount: 0, title: "", bodyTextLength: 900 }),
      false,
    );
  });
});
