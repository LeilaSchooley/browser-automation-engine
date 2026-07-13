import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { describe, it } from "node:test";
import {
  fieldHintsFromFilled,
  learningsFromHistory,
  normalizeFieldHints,
  shouldRecordLearnings,
  synthesizeLearningsFromRun,
} from "../src/learningRecorder.js";
import {
  inferAffordanceIntent,
  isVolatileSelector,
  learningsAsSiteMappings,
  mergeAuthSelectors,
  recordSiteLearning,
  stableAuthSelector,
  AFFORDANCE_INTENTS,
} from "../src/siteLearnings.js";
import { initTestRuntime } from "./helpers/runtime.js";

describe("learningRecorder", () => {
  it("fieldHintsFromFilled uses smart_fill site-mapping shape", () => {
    const { hints, controlSkills } = fieldHintsFromFilled([
      { type: "email", selector: "#user_email" },
      { type: "coverletter", selector: "textarea.bio" },
    ]);
    assert.deepEqual(hints, {
      "#user_email": { mappedTo: "email" },
      "textarea.bio": { mappedTo: "coverLetter" },
    });
    assert.equal(controlSkills.length, 0);
  });

  it("normalizeFieldHints upgrades legacy type→selector records", () => {
    const normalized = normalizeFieldHints({
      email: "#email",
      coverletter: "textarea",
    });
    assert.deepEqual(normalized["#email"], { mappedTo: "email" });
    assert.deepEqual(normalized.textarea, { mappedTo: "coverLetter" });
  });

  it("learningsAsSiteMappings exposes normalized field hints", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-learn-"));
    initTestRuntime({ settings: { site_learnings_path: path.join(dir, "learnings.json") } });

    recordSiteLearning("www.beta.example", {
      fieldHints: { email: "#signup-email" },
      authSelectors: { email: ["#signup-email"] },
      modalSelectors: ["button.next"],
    });

    const maps = learningsAsSiteMappings();
    assert.deepEqual(maps["beta.example"]["#signup-email"], { mappedTo: "email" });
    assert.deepEqual(maps["beta.example"]._apply.modalSteps, ["button.next"]);
  });

  it("shouldRecordLearnings triggers on auth success and partial fills", () => {
    assert.equal(
      shouldRecordLearnings({
        history: [{ action: "auth_signup", ok: true, progress: true }],
        fillResult: { filled: [] },
        snap: {},
      }),
      true,
    );
    assert.equal(
      shouldRecordLearnings({
        history: [],
        fillResult: { filled: [{ type: "email", selector: "#e" }] },
        snap: {},
      }),
      true,
    );
    assert.equal(
      shouldRecordLearnings({
        history: [],
        fillResult: { filled: [] },
        snap: {},
      }),
      false,
    );
  });

  it("synthesizeLearningsFromRun merges history auth/modal hints", () => {
    const { host, patch } = synthesizeLearningsFromRun({
      hostname: "jobs.example.com",
      history: [
        {
          action: "auth_login",
          ok: true,
          learnings: { authSelectors: { email: ["#login-email"] } },
        },
        {
          action: "click_modal",
          ok: true,
          learnings: { modalSelector: "button.wizard-next" },
        },
      ],
      fillResult: {
        filled: [{ type: "email", selector: "#app-email" }],
      },
      snap: { url: "https://jobs.example.com/apply", fieldCount: 4 },
      outcome: "review",
    });

    assert.equal(host, "jobs.example.com");
    assert.equal(patch.authRequired, true);
    assert.deepEqual(patch.fieldHints?.["#app-email"], { mappedTo: "email" });
    assert.deepEqual(patch.authSelectors?.email, ["#login-email"]);
    assert.deepEqual(patch.modalSelectors, ["button.wizard-next"]);
  });

  it("learningsFromHistory keeps progress skills and soft dismiss/board_nav", () => {
    const out = learningsFromHistory([
      {
        ok: true,
        progress: false,
        learnings: {
          affordanceSkills: [{ signature: { textNorm: "bad click" }, successCount: 1 }],
        },
      },
      {
        ok: true,
        progress: true,
        learnings: {
          affordanceSkills: [{ signature: { textNorm: "good click" }, intent: "entry_apply", successCount: 1 }],
        },
      },
      {
        ok: true,
        progress: false,
        learnings: {
          affordanceSkills: [{ signature: { textNorm: "skip thank you" }, intent: "upsell_dismiss", successCount: 1 }],
        },
      },
    ]);
    assert.equal(out.affordanceSkills?.length, 2);
    assert.equal(out.affordanceSkills[0].signature.textNorm, "good click");
    assert.equal(out.affordanceSkills[1].intent, "upsell_dismiss");
  });

  it("mergeAuthSelectors drops volatile vue ids", () => {
    const merged = mergeAuthSelectors(
      { email: ["#v-0-8-1-0-2"] },
      { email: ['input[type="email"]', "#v-0-6-1-0-2"] },
    );
    assert.deepEqual(merged.email, ['input[type="email"]']);
  });

  it("stableAuthSelector prefers testId over volatile id", () => {
    assert.equal(
      stableAuthSelector("#v-0-8-1-0-2", { kind: "email", testId: "login-email" }),
      '[data-testid="login-email"]',
    );
    assert.equal(stableAuthSelector("#email", { kind: "email" }), "#email");
  });

  it("inferAffordanceIntent tags wizard and dismiss clicks", () => {
    assert.equal(
      inferAffordanceIntent(
        { text: "I have a resume", testId: "umja-option-upload-resume", inModal: true },
        {},
        { step: "wizard_choice" },
      ),
      AFFORDANCE_INTENTS.WIZARD_CONTINUE,
    );
    assert.equal(
      inferAffordanceIntent(
        { text: "Skip and continue applying", inModal: true },
        {},
        { step: "overlay" },
      ),
      AFFORDANCE_INTENTS.UPSELL_DISMISS,
    );
    assert.equal(isVolatileSelector("#v-0-8-1-0-2"), true);
  });

  it("inferAffordanceIntent tags board listing clicks as board_nav", () => {
    const boardSnap = {
      url: "https://jobs.ashbyhq.com/ditto",
      pageText: "Open Positions",
      passwordFieldCount: 0,
      fileInputCount: 0,
      fields: [
        { name: "departmentId", label: "Department", type: "select-one" },
        { name: "locationId", label: "Location", type: "select-one" },
      ],
    };
    assert.equal(
      inferAffordanceIntent(
        { text: "Senior Software Engineer, Portal", role: "link" },
        boardSnap,
        { step: "entry" },
      ),
      AFFORDANCE_INTENTS.BOARD_NAV,
    );
  });
});
