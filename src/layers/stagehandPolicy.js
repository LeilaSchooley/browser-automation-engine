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
  pathLooksLikeJobDetail,
} from "../heuristics.js";
import { JOB_BOARD_HOST_RE, JOB_BOARD_PAGE_BODY, APPLY_CTA_PHRASE_RE } from "../patterns/listing.js";
import { hasPreferencesGateFields, getPreferencesFromContext } from "../fillPreferences.js";
import { looksLikePlatformOnboarding, looksLikeBoardSignupOnboarding, looksLikeJobBoardWelcomeConfirm, looksLikeDidYouApplyPrompt } from "../platformOnboarding.js";
import {
  buildApplicationControlsStagehandInstruction,
  hasUnfilledApplicationControls,
} from "../fillApplicationAnswers.js";
import { canUseStagehand, attemptStagehandAct } from "./stagehandAdapter.js";
import { smartFillStalledOnStep } from "./deterministicPolicy.js";
import { isOauthProviderHost, looksLikeDeadApplyDestination } from "./applyUrlSafety.js";

const SAFETY_STEPS = new Set(["loading", "blocked", "enter_otp", "verify_email", "signup_entry"]);

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

function candidateTextBlob(snap) {
  const parts = [];
  for (const list of [
    snap?.entryCandidates,
    snap?.submitCandidates,
    snap?.continueCandidates,
    snap?.interactives,
  ]) {
    for (const c of list || []) {
      parts.push(c.text || "", c.aria || "", c.value || "");
    }
  }
  return parts.join(" ").toLowerCase();
}

/** Apply-ish control visible even when entry scoring missed it. */
export function hasApplyishDomSignal(snap) {
  if ((snap?.entryCount || 0) > 0) return true;
  const blob = candidateTextBlob(snap);
  if (APPLY_CTA_PHRASE_RE.test(blob)) return true;
  if (/\bapply\b/i.test(blob) && !/sign in|log in|register/i.test(blob)) return true;
  return false;
}

/**
 * Soft board signal for instruction routing when classification is ambiguous.
 * Must NOT fire on job-detail URLs (nav "All jobs" / ATS host alone is not enough).
 */
export function looksBoardIsh(snap) {
  if (!snap) return false;
  if (looksLikeJobBoardIndex(snap)) return true;
  // Detail / deep job paths are never soft board indexes.
  if (pathLooksLikeJobDetail(snap)) return false;
  if (hasApplyishDomSignal(snap)) return false;

  const pageBlob = `${snap.title || ""} ${snap.pageText || ""} ${snap.headings || ""}`.toLowerCase();
  const noFile = (snap.fileInputCount || 0) === 0;
  const noPassword = (snap.passwordFieldCount || 0) === 0;

  // Body copy alone is weak (footer "All jobs" / "Careers at X" on JDs) — require empty-ish surface.
  if (JOB_BOARD_PAGE_BODY.test(pageBlob) && noFile && (snap.fieldCount || 0) === 0 && (snap.entryCount || 0) === 0) {
    return true;
  }
  // ATS host at company root only (deep paths already excluded above).
  if (JOB_BOARD_HOST_RE.test(urlHost(snap)) && noFile && noPassword && (snap.entryCount || 0) === 0) {
    return true;
  }
  return false;
}

function topEntryLabel(snap) {
  const top = snap?.entryCandidates?.[0];
  const text = String(top?.text || top?.aria || top?.value || "").trim();
  return text ? text.slice(0, 80) : "";
}

function buildApplyInstruction(jobRef, companyRef, snap = null) {
  const named = topEntryLabel(snap);
  if (named) {
    return (
      `On this job page, click the control labeled exactly "${named}" to start applying for ${jobRef}${companyRef}. ` +
      `Do not click mailto/email links, generic site-wide "Apply" (e.g. YC batch), or other job listings.`
    );
  }
  return (
    `On this job page, click the main role-specific Apply button or link to start applying for ${jobRef}${companyRef}. ` +
    `Prefer labels like "Apply to role", "Apply for the job", "Apply for this job", or "I'm interested". ` +
    `Do not click mailto links, generic "Apply" that leaves the job, or other job listings.`
  );
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
  if (looksLikeDeadApplyDestination(snap).dead) return false;

  if (
    ["auth", "signup", "signup_entry", "signin_entry"].includes(classification?.step) ||
    (snap?.passwordFieldCount || 0) > 0 ||
    isOauthProviderHost(snap?.url || snap?.hostname || "")
  ) {
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

  // Strict board index only — soft board-ish must not short-circuit Apply on detail pages.
  if (looksLikeJobBoardIndex(snap)) return true;

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
 * @param {{ forceApply?: boolean }} [opts]
 */
export function buildStagehandInstruction(snap, classification, history = [], context = {}, opts = {}) {
  const { title, company } = jobContext(context);
  const jobRef = title ? `"${title}"` : "the target job";
  const companyRef = company ? ` at ${company}` : "";

  if (classification?.step === "enter_otp") {
    return (
      "Enter the verification / one-time code from the applicant's email into the code field, then click Verify or Continue. " +
      "Do not navigate away or click social login."
    );
  }

  if (
    ["auth", "signup", "signup_entry", "signin_entry"].includes(classification?.step) ||
    (snap?.passwordFieldCount || 0) > 0
  ) {
    const signupLabel = String(snap?.signUpCandidates?.[0]?.text || "Create an account").trim().slice(0, 60);
    if (classification?.step === "signup_entry") {
      return (
        `Click "${signupLabel}" to open account creation. ` +
        "Never click Google, LinkedIn, Apple, Facebook, Microsoft, GitHub, or any other social/OAuth option."
      );
    }
    return (
      "Use the site's email and password form to continue. " +
      'Prefer the plain Email, Password, "Continue", "Sign in", or "Create account" controls. ' +
      "Never click Google, LinkedIn, Apple, Facebook, Microsoft, GitHub, or any other social/OAuth option."
    );
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

  const boardIndex = looksLikeJobBoardIndex(snap);
  const detailPath = pathLooksLikeJobDetail(snap);
  const forceApply = Boolean(opts.forceApply || classification?.forceApply);
  const applyish = hasApplyishDomSignal(snap);
  const wantsApply =
    forceApply ||
    detailPath ||
    applyish ||
    (!boardIndex &&
      (classification?.step === "entry" || countRecentAction(history, "click_apply", 4) >= 2));

  // Listing picker only on true board indexes — never on job-detail / Apply surfaces.
  if (boardIndex && !forceApply && !detailPath && !applyish) {
    if (title) {
      return `On this job board, click the job listing that best matches ${jobRef}${companyRef}. Do not change filter dropdowns unless necessary.`;
    }
    return "On this job board page, click the most relevant job listing to open its application. Do not fill filter dropdowns.";
  }

  if (wantsApply) {
    return buildApplyInstruction(jobRef, companyRef, snap);
  }

  // Also block Stagehand on soft OTP steps
  if (classification?.step === "enter_otp") {
    return "Enter the email verification code into the OTP field and submit.";
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
  const boardIndex = looksLikeJobBoardIndex(snap);
  return {
    type: "stagehand_act",
    instruction,
    reason: classification?.reason || instruction.slice(0, 100),
    source: "stagehand-policy",
    step: classification?.step,
    // Only persist board_nav after a verified index page — soft board-ish must not poison skills.
    mappedTo: boardIndex ? "board_nav" : undefined,
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
