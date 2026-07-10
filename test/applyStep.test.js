/**
 * Unit checks for affordance-driven step classification (no browser required).
 */
import { classifyApplyStep, stepToPlan, STEP_ACTIONS } from "../src/layers/applyStep.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const jobLeadsModalSnap = {
  pageKind: "modal",
  fieldCount: 0,
  fileInputCount: 0,
  entryCount: 1,
  modalStepCount: 2,
  hasApplyModal: true,
  cookieBanner: false,
  continueCount: 0,
  submitCount: 0,
  applyModalTitle: "Start your application",
  modalCandidates: [
    { text: "I have a resume", testId: "umja-option-upload-resume", score: 140 },
    { text: "I need a resume", testId: "umja-option-open-resume-builder", score: 55 },
  ],
  entryCandidates: [{ text: "I'm interested", testId: "job-preview-apply-button", score: 203 }],
  title: "Platform Engineer | JobLeads.com",
  url: "https://www.jobleads.com/us/job/example",
};

const listingSnap = {
  pageKind: "listing",
  fieldCount: 0,
  fileInputCount: 0,
  entryCount: 1,
  modalStepCount: 0,
  hasApplyModal: false,
  cookieBanner: false,
  continueCount: 0,
  submitCount: 0,
  entryCandidates: [{ text: "Apply", score: 100 }],
  title: "Software Engineer",
  url: "https://example.com/jobs/1",
};

const formSnap = {
  pageKind: "form",
  fieldCount: 5,
  fileInputCount: 0,
  entryCount: 0,
  modalStepCount: 0,
  hasApplyModal: false,
  cookieBanner: false,
  continueCount: 0,
  submitCount: 0,
  fields: [{ type: "text", label: "Name" }],
  title: "Application",
  url: "https://example.com/apply",
};

// JobLeads after apply click: should classify wizard_choice, not form
const c1 = classifyApplyStep(jobLeadsModalSnap, { filled: [], unfilled_count: 0 }, [
  { action: "click_apply", ok: true, progress: true },
]);
assert(c1.step === "wizard_choice", `expected wizard_choice, got ${c1.step}`);
const p1 = stepToPlan(c1, jobLeadsModalSnap, []);
assert(p1.type === "click_modal", `expected click_modal, got ${p1.type}`);

// Listing: should classify entry
const c2 = classifyApplyStep(listingSnap, { filled: [], unfilled_count: 0 }, []);
assert(c2.step === "entry", `expected entry, got ${c2.step}`);
assert(stepToPlan(c2, listingSnap, []).type === "click_apply", "entry → click_apply");

// Form: should classify form
const c3 = classifyApplyStep(formSnap, { filled: [], unfilled_count: 5 }, [
  { action: "click_apply", ok: true, progress: true },
]);
assert(c3.step === "form", `expected form, got ${c3.step}`);
assert(stepToPlan(c3, formSnap, []).type === "smart_fill", "form → smart_fill");

// Never smart_fill with 0 fields via stepToPlan guard
const badForm = classifyApplyStep({ ...listingSnap, fieldCount: 0 }, { filled: [] }, [
  { action: "click_apply", ok: true },
]);
assert(stepToPlan(badForm, { ...listingSnap, fieldCount: 0 }, [])?.type !== "smart_fill", "no smart_fill at 0 fields");

assert(STEP_ACTIONS.wizard_choice === "click_modal", "wizard maps to click_modal");

console.log("applyStep checks passed:", { jobLeads: c1.step, listing: c2.step, form: c3.step });
