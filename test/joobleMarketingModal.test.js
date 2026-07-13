import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyApplyStep } from "../src/layers/applyStep.js";
import { isNonCookiePopup } from "../src/consentDetection.js";
import {
  findBestDismissCandidate,
  isJobAlertInterstitial,
  looksLikeJobAlertSignupForm,
  looksLikeMarketingYesNoModal,
} from "../src/heuristics.js";
import { detectAlertFillMistake, synthesizeLearningsFromRun } from "../src/learningRecorder.js";
import { runSmartFill } from "../src/smartFill.js";
import { inspectPage } from "../src/layers/formDiscovery.js";
import { withFixturePage } from "./helpers/fixtures.js";
import { initTestRuntime } from "./helpers/runtime.js";

const joobleModalSnap = {
  pageKind: "overlay",
  title: "Junior Web Developer — Jooble",
  pageText:
    "Time for a new Job? candidates have already subscribed to Jooble's Job Alerts get new relevant jobs Subscribe and receive new vacancies",
  fieldCount: 1,
  fileInputCount: 0,
  modalCount: 1,
  hasBlockingOverlay: true,
  hasApplyModal: true,
  fields: [{ label: "Email", name: "alertEmail", type: "email" }],
  interactives: [
    { index: 0, text: "Yes", role: "button", inModal: true, kind: "control" },
    { index: 1, text: "No", role: "button", inModal: true, kind: "control" },
    { index: 2, text: "×", aria: "Close", role: "button", inModal: true, kind: "control" },
    { index: 3, text: "OK", role: "button", inModal: false, kind: "control" },
  ],
  dismissCandidates: [],
};

describe("jooble marketing modal", () => {
  it("detects Jooble Yes/No marketing modal", () => {
    assert.equal(looksLikeMarketingYesNoModal(joobleModalSnap), true);
    assert.equal(isJobAlertInterstitial(joobleModalSnap), true);
    assert.equal(isNonCookiePopup(joobleModalSnap), true);
    assert.equal(looksLikeJobAlertSignupForm(joobleModalSnap), true);
  });

  it("findBestDismissCandidate prefers No over Yes", () => {
    const best = findBestDismissCandidate(joobleModalSnap);
    assert.ok(best);
    assert.match(String(best.text || best._text), /^no$/i);
  });

  it("classifyApplyStep routes to overlay before form fill", () => {
    const c = classifyApplyStep(
      joobleModalSnap,
      { filled: [{ type: "email", selector: "#alertEmail" }] },
      [{ action: "click_apply", ok: true }],
      null,
    );
    assert.equal(c.step, "overlay");
    assert.match(c.reason, /dismiss/i);
    assert.ok(c.target);
    assert.match(String(c.target.text || c.target._text), /^no$/i);
  });

  it("classifyApplyStep uses dismissFirst learning on weak signal", () => {
    const snap = {
      ...joobleModalSnap,
      pageText: "Search results for developer",
      modalCount: 1,
      hasBlockingOverlay: true,
      interactives: [{ index: 1, text: "No", role: "button", inModal: true }],
    };
    const c = classifyApplyStep(snap, { filled: [] }, [], {
      siteLearnings: { dismissFirst: true, avoidFillWhenAlert: true },
    });
    assert.equal(c.step, "overlay");
  });

  it("detectAlertFillMistake records dismissFirst after smart_fill on alert form", () => {
    const patch = detectAlertFillMistake({
      history: [{ action: "smart_fill", ok: true, progress: true }],
      fillResult: { filled: [{ type: "email", selector: "#alertEmail" }] },
      snap: joobleModalSnap,
      outcome: "partial",
    });
    assert.deepEqual(patch, { dismissFirst: true, avoidFillWhenAlert: true });
  });

  it("synthesizeLearningsFromRun includes dismissFirst after alert fill mistake", () => {
    const result = synthesizeLearningsFromRun({
      hostname: "jooble.org",
      history: [{ action: "smart_fill", ok: true, progress: true }],
      fillResult: { filled: [{ type: "email", selector: "#alertEmail" }] },
      snap: joobleModalSnap,
      outcome: "partial",
    });
    assert.equal(result.host, "jooble.org");
    assert.equal(result.patch.dismissFirst, true);
    assert.equal(result.patch.avoidFillWhenAlert, true);
  });

  it("runSmartFill skips job-alert signup surfaces", async () => {
    initTestRuntime({
      settings: { browser_human_behavior: false, smart_fill_passes: 1 },
    });
    const log = { layer: () => {} };
    const result = await runSmartFill(
      { evaluate: async () => ({ filled: [], unfilled: [], fileTargets: [] }) },
      {},
      log,
      { snap: joobleModalSnap },
    );
    assert.equal(result.skipped, "job_alert_signup");
    assert.equal(result.filled.length, 0);
  });
});

describe("jooble marketing modal (fixture)", () => {
  it("inspectPage discovers Yes/No modal on Jooble fixture", async () => {
    await withFixturePage("jooble-marketing-modal", async (page) => {
      const snap = await inspectPage(page);
      assert.ok(snap.modalCount >= 1 || snap.hasBlockingOverlay);
      assert.match(snap.pageText || "", /time for a new job/i);
      const c = classifyApplyStep(snap, { filled: [] }, [], null);
      assert.equal(c.step, "overlay");
    });
  });
});
