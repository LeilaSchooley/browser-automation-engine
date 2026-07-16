/**
 * When to route the main agent loop through Stagehand observe/act instead of DOM classifiers.
 */
import {
  applyEntrySucceeded,
  countRecentAction,
  looksLikeJobBoardIndex,
  looksLikeInlineApplicationForm,
  hasUnfilledApplicationFields,
  uploadStalled,
  pageFingerprintFromSnap,
  looksLikeApplySignupGate,
  isResumeReviewUpsell,
  isExpertReviewGate,
  looksLikeGoogleVignetteAd,
} from "../heuristics.js";
import { JOB_BOARD_HOST_RE, JOB_BOARD_PAGE_BODY } from "../patterns/listing.js";
import { hasPreferencesGateFields, getPreferencesFromContext } from "../fillPreferences.js";
import { looksLikePlatformOnboarding, looksLikeBoardSignupOnboarding, looksLikeJobBoardWelcomeConfirm, looksLikeDidYouApplyPrompt } from "../platformOnboarding.js";
import {
  buildApplicationControlsStagehandInstruction,
  hasUnfilledApplicationControls,
} from "../fillApplicationAnswers.js";
import { canUseStagehand, attemptStagehandAct } from "./stagehandAdapter.js";
import { smartFillStalledOnStep } from "./deterministicPolicy.js";

const SAFETY_STEPS = new Set(["loading", "blocked"]);

function jobContext(context = {}) {
  const job = context.job || context.listing || {};
  return {
    title: String(job.title || context.jobTitle || context.listingTitle || "").trim(),
    company: String(job.company || context.jobCompany || context.company || "").trim(),
  };
}

function urlHost(snap) {
  try {
    return new URL(String(snap?.url || "")).hostname.toLowerCase();
  } catch {
    return String(snap?.hostname || "").toLowerCase();
  }
}

/** Soft board signal for instruction routing when classification is ambiguous. */
export function looksBoardIsh(snap) {
  if (!snap) return false;
  if (looksLikeJobBoardIndex(snap)) return true;
  const pageBlob = `${snap.title || ""} ${snap.pageText || ""} ${snap.headings || ""}`.toLowerCase();
  if (JOB_BOARD_PAGE_BODY.test(pageBlob) && (snap.fileInputCount || 0) === 0) return true;
  if (JOB_BOARD_HOST_RE.test(urlHost(snap)) && (snap.fileInputCount || 0) === 0 && (snap.passwordFieldCount || 0) === 0) {
    return true;
  }
  return false;
}

/**
 * @param {object} snap
 * @param {object} classification
 * @param {object[]} history
 * @param {object} context
 */
export function shouldPreferStagehand(snap, classification, history = [], context = {}, fillResult = null) {
  const gate = canUseStagehand(context);
  if (!gate.ok) return false;
  if (SAFETY_STEPS.has(classification?.step)) return false;

  if (classification?.step === "signup" || classification?.step === "signup_entry" || classification?.step === "signin_entry") {
    return false;
  }
  if (looksLikeApplySignupGate(snap)) return false;
  if (looksLikePlatformOnboarding(snap)) return false;
  if (looksLikeBoardSignupOnboarding(snap)) return false;
  if (looksLikeJobBoardWelcomeConfirm(snap)) return false;
  if (looksLikeDidYouApplyPrompt(snap)) return false;
  if (isResumeReviewUpsell(snap) || isExpertReviewGate(snap)) return false;
  if (looksLikeGoogleVignetteAd(snap)) return false;

  const fp = classification?.fingerprint || pageFingerprintFromSnap(snap);

  if (looksLikeJobBoardIndex(snap) || looksBoardIsh(snap)) return true;

  if (uploadStalled(history) && (snap?.fileInputCount || 0) > 0) return true;

  if (
    looksLikeInlineApplicationForm(snap) &&
    uploadStalled(history) &&
    hasUnfilledApplicationFields(snap, fillResult)
  ) {
    return true;
  }

  if (classification?.step === "entry") {
    if ((snap?.entryCount || 0) === 0) return true;
    if (countRecentAction(history, "click_apply", 4) >= 2 && !applyEntrySucceeded(history, fp)) return true;
  }

  // Ambiguous alone is not enough — only when board-ish or stuck with no entry candidates.
  if (classification?.step === "ambiguous") {
    if (looksBoardIsh(snap)) return true;
    if ((snap?.entryCount || 0) === 0 && (snap?.fileInputCount || 0) === 0 && (snap?.fieldCount || 0) < 2) {
      return true;
    }
    return false;
  }

  if (smartFillStalledOnStep(history, classification) && looksLikeJobBoardIndex(snap)) return true;

  if (
    classification?.step === "form" &&
    classification?.confidence === "low" &&
    (snap?.entryCount || 0) === 0 &&
    looksLikeJobBoardIndex(snap)
  ) {
    return true;
  }

  if (countRecentAction(history, "click_apply", 5) >= 2 && !applyEntrySucceeded(history, fp)) return true;

  return false;
}

/**
 * @param {object} snap
 * @param {object} classification
 * @param {object[]} history
 * @param {object} context
 */
export function buildStagehandInstruction(snap, classification, history = [], context = {}) {
  const { title, company } = jobContext(context);
  const jobRef = title ? `"${title}"` : "the target job";
  const companyRef = company ? ` at ${company}` : "";

  if (looksLikeJobBoardIndex(snap) || looksBoardIsh(snap)) {
    if (title) {
      return `On this job board, click the job listing that best matches ${jobRef}${companyRef}. Do not change filter dropdowns unless necessary.`;
    }
    return "On this job board page, click the most relevant job listing to open its application. Do not fill filter dropdowns.";
  }

  if (uploadStalled(history) && (snap?.fileInputCount || 0) > 0) {
    const applicant = context.applicant || context.profile || {};
    const name = [applicant.firstName, applicant.lastName].filter(Boolean).join(" ") || applicant.name || "";
    const email = applicant.email || "";
    const parts = [
      "Upload the resume PDF to the required Resume field (use the hidden file input if needed)",
    ];
    if (name) parts.push(`fill Name with ${name}`);
    if (email) parts.push(`fill Email with ${email}`);
    if (applicant.linkedin) parts.push(`fill LinkedIn with ${applicant.linkedin}`);
    parts.push("Do not click Submit yet");
    return `${parts.join("; ")}.`;
  }

  if (classification?.step === "entry" || countRecentAction(history, "click_apply", 4) >= 2) {
    return `Click the Apply button or link to start applying for ${jobRef}${companyRef}.`;
  }

  if (hasPreferencesGateFields(snap)) {
    const prefs = getPreferencesFromContext(context);
    const parts = [];
    if (prefs.salary) parts.push(`select Salary expectations closest to ${prefs.salary}, then click Save to confirm`);
    if (prefs.location) parts.push(`ensure Location is ${prefs.location}`);
    if (prefs.desiredTitle) parts.push(`ensure Desired job title is set`);
    if (parts.length) {
      return `In the preferences modal: ${parts.join("; ")}. Verify salary field no longer shows ? before continuing.`;
    }
  }

  return `Complete the next step to apply for ${jobRef}${companyRef}. Prefer filling unlabeled required fields over clicking Submit.`;
}

/**
 * @param {object} snap
 * @param {object} classification
 * @param {object[]} history
 * @param {object} context
 */
export function buildStagehandPlan(snap, classification, history = [], context = {}) {
  const instruction = buildStagehandInstruction(snap, classification, history, context);
  return {
    type: "stagehand_act",
    instruction,
    reason: classification?.reason || instruction.slice(0, 100),
    source: "stagehand-policy",
    step: classification?.step,
    mappedTo: looksBoardIsh(snap) ? "board_nav" : undefined,
  };
}

/**
 * Belt-and-suspenders: one Stagehand act when visa/EEOC yes-no still unfilled after smart_fill.
 * @param {import('playwright').Page} page
 * @param {object} context
 * @param {{ snap?: object, log?: object, history?: object[] }} [opts]
 */
export async function attemptApplicationControlsStagehand(page, context, opts = {}) {
  const snap = opts.snap || null;
  const log = opts.log || null;
  const history = opts.history || [];

  if (!hasUnfilledApplicationControls(snap)) {
    return { ok: false, reason: "none_unfilled" };
  }
  const gate = canUseStagehand(context);
  if (!gate.ok) {
    return { ok: false, reason: gate.reason || "stagehand_unavailable" };
  }

  const fp = pageFingerprintFromSnap(snap);
  const alreadyTried = history
    .slice(-8)
    .some(
      (h) =>
        h.action === "stagehand_act" &&
        h.source === "application-controls" &&
        h.fingerprint === fp,
    );
  if (alreadyTried) {
    return { ok: false, reason: "already_tried" };
  }

  const instruction = buildApplicationControlsStagehandInstruction(context);
  log?.layer("stagehand", `application controls fallback: ${instruction.slice(0, 100)}`, "info");
  const result = await attemptStagehandAct(page, context, { instruction, log });
  return { ...result, instruction, source: "application-controls" };
}
