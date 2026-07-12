import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { describe, it } from "node:test";
import {
  fieldHintsFromFilled,
  normalizeFieldHints,
  shouldRecordLearnings,
  synthesizeLearningsFromRun,
} from "../src/learningRecorder.js";
import { learningsAsSiteMappings, recordSiteLearning } from "../src/siteLearnings.js";
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
});
