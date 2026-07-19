/** Dynamic text/heuristic helpers — no site-specific selectors. */

import { normalizeHost } from "./host.js";
import { isSeoJobBoardHost } from "./layers/applyUrlSafety.js";
import {
  APPLICATION_FIELD_RE,
  JOB_ALERT_FIELD_RE,
  JOB_ALERT_SIGNUP_BODY,
  JOB_BOARD_FILTER_FIELD_RE,
  JOB_BOARD_HOST_RE,
  JOB_BOARD_JOB_PATH_RE,
  JOB_BOARD_PAGE_BODY,
  CLOSED_JOB_BODY,
  CLOSED_JOB_URL_RE,
} from "./patterns/listing.js";
import { APPLY_SIGNUP_GATE_TEXT } from "./patterns/auth.js";

export const FILE_UPLOAD_TEXT =
  /\b(upload\s+(a\s+)?resume|upload\s+(your\s+)?cv|attach\s+(a\s+)?resume|attach\s+cv|select\s+file|choose\s+file|browse\s+files?|import\s+resume|drag\s+(and\s+)?drop|add\s+resume|use\s+my\s+resume)\b/i;

export const FILE_INPUT_HINT_TEXT = /\b(uploader|file-input|resume-upload|cv-upload|file_upload)\b/i;

/** Post-upload expert review / resume polish gate (JobLeads and similar). */
export const EXPERT_REVIEW_GATE_TEXT =
  /\b(expert review|free expert review|free expert resume review|resume score|resume is not recommended|not recommended|skip free expert|resume is not ready yet|not ready yet\?|get a free expert)\b/i;

/** Flexible match for "Skip and continue" / "Skip & continue" (spacing varies in DOM). */
export const SKIP_AND_CONTINUE_PATTERN = /skip\s*(and|&)\s*continue/i;

/** JobLeads resume-score gate (2025+): "Skip free expert review" on card CTAs. */
export const SKIP_FREE_EXPERT_REVIEW_PATTERN = /skip\s+free\s+expert(\s+review)?/i;

/** Secondary actions that dismiss an interstitial / upsell (any site). */
export const INTERSTITIAL_DISMISS_TEXT =
  /^(skip|skip to (application|apply)|skip and continue|skip & continue|skip free expert( review)?|no[, ]?thanks|not now|maybe later|continue without( documents)?|dismiss|close|exit|no,? pass|i'?ll pass|skip (for )?now|continue to (apply|job)|no,? i'?m good)$/i;

/** Playwright getByRole patterns — tried in order (most specific first). */
export const INTERSTITIAL_DISMISS_PATTERNS = [
  /^Skip free expert review$/i,
  /skip\s+free\s+expert(\s+review)?/i,
  /^Skip and continue$/i,
  /^Skip & continue$/i,
  /skip\s*(and|&)\s*continue/i,
  /^Skip to application$/i,
  /^Skip to apply$/i,
  /^Skip$/i,
  /^EXIT$/i,
  /^Exit$/i,
  /^Continue without documents$/i,
  /^Continue without$/i,
  /^No[, ]?thanks$/i,
  /^Not now$/i,
  /^Maybe later$/i,
  /^Dismiss$/i,
  /^Close$/i,
  /^Continue to (apply|job)$/i,
  /skip to (application|apply)/i,
  /^skip for now$/i,
  /^do it later$/i,
];

/** Copy that means "this dialog is an upsell/paywall, not the application". */
export const INTERSTITIAL_UPSELL_BODY =
  /\b(auto-?rejected|won[\u2019']?t reach a human|ats software will filter|fix my resume|quick wins to improve|successful candidates score|increase your chances|tailor your resume|boost your resume|boost your resume here|customize your resume|customizing your resume|stand out among applicants|paste any linkedin|linkedin profile url|get more replies|expert review|free expert review|free expert resume review|resume score|resume is not recommended|not recommended|\/\d+\/100|resume is not ready yet|not ready yet|upgrade (now|your)|go premium|paywall|orion)\b/i;

/** @deprecated use INTERSTITIAL_UPSELL_BODY */
export const RESUME_REVIEW_UPSELL_TEXT = INTERSTITIAL_UPSELL_BODY;

export function modalTextBlob(snap) {
  if (!snap) return "";
  return [
    snap.pageText,
    snap.applyModalTitle,
    ...(snap.modalCandidates || []).map((c) => blobFromCandidate(c)),
    ...(snap.interactives || []).map((i) => `${i.text || ""} ${i.aria || ""}`),
  ]
    .filter(Boolean)
    .join(" ");
}

/** Post-upload optional review gate — behavioral: score tease + dismissible CTA, not workflow. */
export function isExpertReviewGate(snap) {
  return EXPERT_REVIEW_GATE_TEXT.test(modalTextBlob(snap));
}

/** Behavioral wizard signals — file upload, resume choice, application continuation. */
export const APPLY_WIZARD_SIGNALS =
  /continue application|upload resume|start your application|i have a resume|attach resume|choose resume|wizard-option|modal-cta/i;

/** Best dismiss/skip control on the page — prefers Skip and continue over weaker skips. */
export function findBestDismissCandidate(snap) {
  const pool = [];
  const marketingAlert = isJobAlertInterstitial(snap) && !hasApplicationSurfaceFields(snap);
  const resumeUpsell = isResumeReviewUpsell(snap) || isExpertReviewGate(snap);

  for (const c of snap?.dismissCandidates || []) {
    pool.push({ ...c, _text: c.text || c.aria || "" });
  }
  for (const i of snap?.interactives || []) {
    if (textMatchesInterstitialDismiss(i.text || i.aria)) {
      pool.push({ ...i, _text: i.text || i.aria || "", source: i.source || "interactive" });
    }
    if (marketingAlert || resumeUpsell) {
      const t = String(i.text || i.aria || "").trim();
      if (/^no$/i.test(t) || /^no[, ]?thanks$/i.test(t) || /^(close|×|✕|x|decline)$/i.test(t)) {
        pool.push({ ...i, _text: t, source: i.source || (resumeUpsell ? "resume-upsell" : "marketing-modal") });
      }
    }
  }
  if (!pool.length) return null;
  const rank = (c) => {
    const t = String(c._text || "").toLowerCase();
    if (marketingAlert || resumeUpsell) {
      // Explicit No declines the offer; × may only hide UI without unsubscribing Intent.
      if (/^no$/i.test(t.trim()) || /^no[, ]?thanks$/i.test(t)) return 98;
      if (/^(close|×|✕|x|decline)$/i.test(t.trim())) return resumeUpsell ? 95 : 80;
    }
    if (SKIP_FREE_EXPERT_REVIEW_PATTERN.test(t)) return 105;
    if (SKIP_AND_CONTINUE_PATTERN.test(t)) return 100;
    if (/skip to application|skip to apply/i.test(t)) return 90;
    if (/^skip$/i.test(t.trim())) return 80;
    if (/no[, ]?thanks|not now|maybe later|skip for now|do it later/i.test(t)) return 70;
    if (/continue without/i.test(t)) return 15;
    return 50;
  };
  return pool.sort((a, b) => rank(b) - rank(a))[0];
}

/** Legitimate apply wizard — not a marketing upsell. */
export function isActiveApplyWizard(snap) {
  if (isExpertReviewGate(snap)) return false;
  if (!snap?.hasApplyModal) return false;
  if ((snap.fileInputCount || 0) > 0) return true;
  if (isResumeChoiceStep(snap)) return true;

  if (APPLY_WIZARD_SIGNALS.test(snap.applyModalTitle || "")) return true;

  for (const c of snap.modalCandidates || []) {
    const blob = blobFromCandidate(c);
    if (APPLY_WIZARD_SIGNALS.test(blob)) return true;
    if (candidateSuggestsFileUpload(c)) return true;
    if (/continue-with-email|wizard-option|modal-cta/i.test(`${c.testId || ""} ${c.selector || ""}`)) return true;
  }

  for (const f of snap.fileInputCandidates || []) {
    if (/uploader|file-input|resume-upload/i.test(`${f.testId || ""} ${f.selector || ""}`)) return true;
  }

  return false;
}

export function textMatchesInterstitialDismiss(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (SKIP_FREE_EXPERT_REVIEW_PATTERN.test(t)) return true;
  if (SKIP_AND_CONTINUE_PATTERN.test(t)) return true;
  if (INTERSTITIAL_DISMISS_TEXT.test(t)) return true;
  return INTERSTITIAL_DISMISS_PATTERNS.some((p) => p.test(t));
}

/** True when a non-apply dialog is blocking (upsell, score tease, sponsored modal). */
export function isBlockingInterstitial(snap) {
  if (!snap) return false;
  if (isActiveApplyWizard(snap)) return false;
  const hints = snap.overlayHints || [];
  const hasDialogSurface =
    snap.hasBlockingOverlay ||
    ((snap.modalCount || 0) > 0 && Boolean(snap.hasApplyModal || snap.applyModalTitle)) ||
    (snap.dismissCandidates || []).some((c) => textMatchesInterstitialDismiss(c.text));

  if (hints.some((h) => /interstitial|resume-review-upsell|upsell/i.test(h)) && hasDialogSurface) {
    return true;
  }
  if ((snap.dismissCandidates || []).some((c) => /interstitial|upsell/i.test(c.source || ""))) return true;

  // Prefer dialog-scoped copy — full pageText matches listing chrome and caused Escape loops.
  const surfaceBlob = [
    snap.applyModalTitle,
    ...(snap.modalCandidates || []).map((c) => `${c.text || ""} ${c.testId || ""}`),
    ...(snap.dismissCandidates || []).map((c) => `${c.text || ""} ${c.testId || ""}`),
    ...(snap.overlayHints || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/[\u2018\u2019']/g, "'");

  if (INTERSTITIAL_UPSELL_BODY.test(surfaceBlob) && hasDialogSurface) return true;

  // Full-page match only with a real blocking overlay (not leftover modalCount).
  if (snap.hasBlockingOverlay) {
    const pageBlob = String(snap.pageText || "")
      .toLowerCase()
      .replace(/[\u2018\u2019']/g, "'");
    if (INTERSTITIAL_UPSELL_BODY.test(pageBlob)) return true;
  }

  return false;
}

export function isResumeReviewUpsell(snap) {
  if (isBlockingInterstitial(snap)) return true;
  const title = String(snap?.applyModalTitle || "").toLowerCase();
  if (
    /boost your resume|improve your resume|tailor your resume|customize your resume|stand out among applicants|^orion$/i.test(
      title,
    )
  ) {
    return true;
  }
  const surface = [
    snap?.applyModalTitle,
    ...(snap?.modalCandidates || []).map((c) => `${c.text || ""}`),
    ...(snap?.dismissCandidates || []).map((c) => `${c.text || ""}`),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const hasDialog =
    snap?.hasBlockingOverlay ||
    ((snap?.modalCount || 0) > 0 && (snap?.hasApplyModal || title)) ||
    (snap?.dismissCandidates || []).some((c) => textMatchesInterstitialDismiss(c.text));

  // Jobright Orion / Boost pane — require a real dialog, not listing chrome alone.
  if (
    /boost your resume here|boost your resume|customizing your resume just got easier|access the tailoring tool|stand out among applicants/i.test(
      `${surface} ${title}`,
    ) &&
    hasDialog
  ) {
    return true;
  }
  if (
    /boost your resume|paste any linkedin profile|customize your resume in \d+|customizing your resume|stand out among applicants/i.test(
      `${surface} ${title}`,
    ) &&
    snap?.hasApplyModal &&
    hasDialog
  ) {
    return true;
  }
  return false;
}

/**
 * Same action repeating without progress — recovery breaker.
 * @param {object[]} history
 * @param {string} action
 * @param {number} [min=2]
 */
export function actionLoopStalled(history, action, min = 2) {
  const recent = (history || []).filter((h) => h.action === action).slice(-min);
  if (recent.length < min) return false;
  return recent.every((h) => !h.progress);
}

/** Dismiss Escape/upsell loop — prefer Apply / continue instead. */
export function dismissLoopStalled(history, min = 2) {
  return actionLoopStalled(history, "dismiss_overlay", min);
}

/**
 * click_continue / Next repeating without application fill progress.
 * Board wizards advance `?step=` so `progress` can be true — still treat filled===0 as looping.
 */
export function continueLoopStalled(history, fillResult = null, min = 3) {
  const continues = (history || []).filter((h) => h.action === "click_continue").slice(-min);
  if (continues.length < min) return false;
  const filled = fillResult?.filled?.length || 0;
  if (filled === 0) return true;
  return continues.every((h) => !h.progress);
}

/** Absolute count breaker — escalate after N attempts of the same action (ignores progress flag). */
export function actionAttemptLimit(history, action, max = 4) {
  return (history || []).filter((h) => h.action === action).length >= max;
}

/** True after a successful leave from board signup onboard (nav_recovery source). */
export function boardLeaveSucceeded(history) {
  return (history || []).some((h) => {
    if (h.action !== "nav_recovery") return false;
    const src = `${h.source || ""} ${h.reason || ""} ${h.recoveryAction || ""}`;
    return /leave_board_onboard|board.?signup/i.test(src);
  });
}

/** Block board Sign Up after we already left the onboard trap this run. */
export function shouldBlockBoardSignupAfterLeave(history, snap = null) {
  if (!boardLeaveSucceeded(history)) return false;
  const url = String(snap?.url || "");
  // Still allow real ATS registration
  if (/(lever\.co|greenhouse\.io|ashbyhq\.com|myworkdayjobs|workable\.com)/i.test(url)) return false;
  return true;
}

export const MARKETING_JOB_ALERT_BODY =
  /receive the latest jobs|be the first to know|setemail alert|job alert|time for a new job|candidates have already subscribed|get new relevant jobs|subscribe and receive new vacancies|new vacancies|jdJbeAlertPopUp|phlexPopup/i;

/** Google vignette / survey interstitial (often #google_vignette + AdChoices). */
export const GOOGLE_VIGNETTE_BODY =
  /\b(choose your job type|tap to see results|continue to see results|adchoices|full-time.*part-time|part-time.*full-time)\b/i;

/**
 * Google Ads vignette blocking the page (#google_vignette, adsbygoogle vignette iframe).
 * Not an apply form — must dismiss / Escape before any fill or Apply click.
 */
export function looksLikeGoogleVignetteAd(snap) {
  if (!snap) return false;
  const url = String(snap.url || "");
  if (/#google_vignette\b/i.test(url) || /[?&]google_vignette=/i.test(url)) return true;
  const hints = snap.overlayHints || [];
  if (hints.some((h) => /google-vignette|vignette-ad|adsbygoogle-vignette/i.test(h))) return true;
  const blob = [
    snap.pageText,
    snap.applyModalTitle,
    snap.headings,
    ...(snap.interactives || []).map((i) => `${i.text || ""} ${i.aria || ""}`),
    ...(snap.dismissCandidates || []).map((c) => c.text),
  ]
    .filter(Boolean)
    .join(" ");
  if (!GOOGLE_VIGNETTE_BODY.test(blob)) return false;
  // Survey + Close/AdChoices typical of vignette — not a real job preferences gate
  return (
    snap.hasBlockingOverlay ||
    (snap.modalCount || 0) > 0 ||
    /close|adchoices/i.test(blob)
  );
}

/** @deprecated alias */
const JOB_ALERT_POPUP_BODY = MARKETING_JOB_ALERT_BODY;

function marketingJobAlertBlob(snap) {
  return [
    snap?.pageText,
    snap?.title,
    snap?.applyModalTitle,
    snap?.headings,
    ...(snap?.overlayHints || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** Application fields (resume, visa, etc.) — not marketing alert signup. */
export function hasApplicationSurfaceFields(snap) {
  if (!snap) return false;
  if ((snap.fileInputCount || 0) > 0) return true;
  const fieldBlob = (snap.fields || [])
    .map((f) => `${f.label || ""} ${f.name || ""} ${f.placeholder || ""}`)
    .join(" ");
  if (APPLICATION_FIELD_RE.test(fieldBlob)) return true;
  if ((snap.customControls || []).some((c) => /yesno|visa|eeoc|sponsorship/i.test(`${c.label || ""} ${c.mappedTo || ""}`))) {
    return true;
  }
  return false;
}

function hasMarketingYesNoControls(snap) {
  const pool = [
    ...(snap?.interactives || []),
    ...(snap?.modalCandidates || []),
    ...(snap?.dismissCandidates || []),
  ];
  let hasYes = false;
  let hasNo = false;
  let hasClose = false;
  for (const c of pool) {
    const t = String(c.text || c.aria || "").trim();
    if (/^yes$/i.test(t)) hasYes = true;
    if (/^no$/i.test(t) || /^no[, ]?thanks$/i.test(t)) hasNo = true;
    if (/^(close|×|✕|x|dismiss|decline)$/i.test(t)) hasClose = true;
  }
  return (hasYes && hasNo) || hasClose;
}

/**
 * Jooble-style marketing modal: Yes/No job-alert upsell with no application fields.
 */
export function looksLikeMarketingYesNoModal(snap) {
  if (!snap) return false;
  const hasModal =
    (snap.modalCount || 0) > 0 || snap.hasBlockingOverlay || snap.hasApplyModal;
  if (!hasModal) return false;
  if (!MARKETING_JOB_ALERT_BODY.test(marketingJobAlertBlob(snap))) return false;
  if (hasApplicationSurfaceFields(snap)) return false;
  return hasMarketingYesNoControls(snap);
}

/** WhatJobs / Phlex job-alert signup overlay — not an apply form or cookie consent. */
export function isJobAlertInterstitial(snap) {
  if (!snap) return false;
  if (looksLikeMarketingYesNoModal(snap)) return true;
  if (looksLikeJobAlertSignupForm(snap) && ((snap.modalCount || 0) > 0 || snap.hasBlockingOverlay)) {
    return true;
  }
  const fieldLabels = (snap.fields || [])
    .map((f) => `${f.label || ""} ${f.name || ""} ${f.placeholder || ""}`)
    .join(" ");
  const blob = [
    snap.pageText,
    snap.title,
    fieldLabels,
    ...(snap.overlayHints || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (!JOB_ALERT_POPUP_BODY.test(blob)) return false;
  return (snap.fieldCount || 0) >= 2 || (snap.modalCount || 0) > 0 || snap.hasBlockingOverlay;
}

/**
 * Job-board "Sign up to apply" modal — platform account gate, not the employer ATS form.
 * Often shows email first; password may appear on the same step or after Continue.
 */
export function looksLikeApplySignupGate(snap) {
  if (!snap) return false;

  const blob = [
    snap.title,
    snap.applyModalTitle,
    snap.pageText,
    snap.headings,
    ...(snap.submitCandidates || []).map((c) => c.text),
    ...(snap.signUpCandidates || []).map((c) => c.text),
    ...(snap.modalCandidates || []).map((c) => c.text),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (APPLY_SIGNUP_GATE_TEXT.test(blob)) return true;

  const fieldBlob = (snap.fields || [])
    .map((f) => `${f.id || ""} ${f.name || ""} ${f.selector || ""} ${f.label || ""}`)
    .join(" ")
    .toLowerCase();
  if (/sign[-_]?up[_-]?(email|password)|#sign-up/.test(fieldBlob)) return true;

  const host = normalizeHost(snap.hostname || snap.url || "");
  if (/jobright\.ai$/i.test(host) && snap.hasApplyModal && /sign[- ]?up/.test(blob)) {
    return true;
  }

  return false;
}

/** Inline job-alert / newsletter signup form — not a real application. */
export function looksLikeJobAlertSignupForm(snap) {
  if (!snap || (snap.fieldCount || 0) < 1) return false;

  const fields = snap.fields || [];
  const fieldBlob = fields
    .map((f) => `${f.name || ""} ${f.label || ""} ${f.placeholder || ""} ${f.type || ""}`)
    .join(" ")
    .toLowerCase();

  if (APPLICATION_FIELD_RE.test(fieldBlob)) return false;
  if ((snap.fileInputCount || 0) > 0) return false;

  const pageBlob = `${snap.title || ""} ${snap.pageText || ""} ${snap.headings || ""}`.toLowerCase();
  const hasAlertCopy =
    JOB_ALERT_SIGNUP_BODY.test(pageBlob) ||
    JOB_ALERT_SIGNUP_BODY.test(fieldBlob) ||
    MARKETING_JOB_ALERT_BODY.test(pageBlob);

  const hasEmail = /\b(email|personemail|your email)\b/i.test(fieldBlob) ||
    fields.some((f) => f.type === "email");
  const hasName = /\b(name|personname|your name|full name)\b/i.test(fieldBlob);

  if (hasEmail && hasAlertCopy && !hasName && (snap.fieldCount || 0) <= 2) {
    return true;
  }

  if ((snap.fieldCount || 0) < 2) return false;
  if (!hasName || !hasEmail) return false;

  const categorySelect = fields.some(
    (f) =>
      f.type === "select-one" &&
      /c\+\+|devops|java|javascript|php|python|ruby|tech|mobile|blockchain/i.test(f.label || ""),
  );

  return (
    JOB_ALERT_FIELD_RE.test(fieldBlob) ||
    hasAlertCopy ||
    (categorySelect && (snap.fieldCount || 0) <= 4)
  );
}

/**
 * Aggregator mirror where the original posting is closed/unavailable.
 * Jooble: orange "requires local presence" + similar jobs, or SearchResult?closedJob=True.
 * Jobright: "This job has closed." banner (don't pivot to Recommended).
 */
export function looksLikeClosedJobListing(snap) {
  if (!snap) return { closed: false, reason: "" };

  const url = String(snap.url || "");
  if (CLOSED_JOB_URL_RE.test(url)) {
    return {
      closed: true,
      reason: "job listing closed — redirected to similar jobs search",
    };
  }

  const blob = `${snap.title || ""} ${snap.pageText || ""} ${snap.headings || ""}`.toLowerCase();
  if (!CLOSED_JOB_BODY.test(blob)) return { closed: false, reason: "" };

  const hostBlob = `${snap.hostname || ""} ${url}`;
  const onAggregator =
    /jooble\.org|indeed\.com|ziprecruiter|talent\.com|simplyhired|jobright\.ai|whatjobs\.|neuvoo|devitjobs/i.test(
      hostBlob,
    );

  // Explicit closed banner — stop even if Recommended jobs remain.
  if (/this job has closed|job has closed|this (job|position|role) has closed/i.test(blob)) {
    return {
      closed: true,
      reason: onAggregator
        ? "original job closed on aggregator — do not apply to recommended substitutes"
        : "original job has closed — skip apply",
    };
  }

  const similarJobsRail =
    /similar jobs that could be interesting|view similar jobs below|based on the .+ vacancy/i.test(blob);

  if (similarJobsRail || /requires local presence|no longer available|view similar jobs/i.test(blob)) {
    return {
      closed: true,
      reason: onAggregator
        ? "original job unavailable on aggregator — similar jobs only"
        : "original job unavailable — similar jobs suggested instead",
    };
  }

  return { closed: false, reason: "" };
}

/** Whether the page exposes a real apply path (CTA, modal, or non-alert submit). */
export function hasRealApplyAffordance(snap) {
  if (!snap) return false;
  if ((snap.entryCount || 0) > 0) return true;
  if (snap.hasApplyModal) return true;
  if ((snap.modalStepCount || 0) > 0 && snapSuggestsFileUpload(snap)) return true;

  for (const c of snap.submitCandidates || []) {
    const blob = blobFromCandidate(c).toLowerCase();
    if (blob && !/alert|subscribe|notify|newsletter/i.test(blob)) return true;
  }
  return false;
}

/**
 * Scraped job-board trap: listing page with no apply button, often only alert signup.
 * Typically reached after click_apply redirects to an SEO mirror (devitjobs, etc.).
 */
export function looksLikeFakeJobListing(snap, history = []) {
  if (!snap) return { fake: false, reason: "" };

  const closed = looksLikeClosedJobListing(snap);
  if (closed.closed) {
    return { fake: true, reason: closed.reason };
  }

  const clickedApply = (history || []).some((h) => h.action === "click_apply" && h.ok);
  if (!clickedApply) return { fake: false, reason: "" };

  if (looksLikeJobAlertSignupForm(snap)) {
    return {
      fake: true,
      reason: "job board alert signup only — no real application form",
    };
  }

  const host = normalizeHost(snap.hostname || snap.url);
  const listingBlob = `${snap.title || ""} ${snap.pageText || ""}`.toLowerCase();
  const looksLikeListing =
    /\bjob in\b|\bjobs in\b|salary|full-time|part-time|£|\$[\d,]+/i.test(listingBlob);
  const noApply = !hasRealApplyAffordance(snap);

  if (noApply && looksLikeListing && (snap.fieldCount || 0) <= 3) {
    if (isSeoJobBoardHost(host)) {
      return {
        fake: true,
        reason: `scraped job listing on ${host} — no apply button`,
      };
    }
    if (JOB_ALERT_FIELD_RE.test(fieldsNameBlob(snap))) {
      return {
        fake: true,
        reason: "scraped job listing — no apply button",
      };
    }
  }

  return { fake: false, reason: "" };
}

/**
 * Company job-board index (Ashby / Greenhouse / Lever filters, "Open Positions") —
 * pick a role, do not fill filters as applicant preferences.
 */
export function looksLikeJobBoardIndex(snap) {
  if (!snap) return false;

  const fields = snap.fields || [];
  const fieldBlob = fields
    .map((f) => `${f.name || ""} ${f.label || ""} ${f.placeholder || ""}`)
    .join(" ");

  const url = String(snap.url || "");
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    host = String(snap.hostname || "").toLowerCase();
  }
  const pathAndQuery = (() => {
    try {
      const u = new URL(url);
      return `${u.pathname}${u.search}`;
    } catch {
      return url;
    }
  })();

  const pageBlob = `${snap.title || ""} ${snap.pageText || ""} ${snap.headings || ""} ${url}`.toLowerCase();

  const selectFields = fields.filter((f) => /select/i.test(String(f.type || "")));
  const allSelects = fields.length >= 2 && selectFields.length === fields.length;
  const filterFields = JOB_BOARD_FILTER_FIELD_RE.test(fieldBlob);
  const openPositions = JOB_BOARD_PAGE_BODY.test(pageBlob);
  const atsBoardHost = JOB_BOARD_HOST_RE.test(host);
  const pathParts = (() => {
    try {
      return new URL(url).pathname.split("/").filter(Boolean);
    } catch {
      return String(pathAndQuery || "")
        .split(/[?#]/)[0]
        .split("/")
        .filter(Boolean);
    }
  })();
  // ATS company roots are 1 segment; job pages are 2+ (Ashby/Lever/Greenhouse).
  const deepJobPath =
    JOB_BOARD_JOB_PATH_RE.test(pathAndQuery) || (atsBoardHost && pathParts.length >= 2);

  const hasApplyFields =
    fields.some((f) => {
      const blob = `${f.name || ""} ${f.label || ""}`.toLowerCase();
      return /email|first.?name|last.?name|resume|phone|cover/i.test(blob);
    }) || APPLICATION_FIELD_RE.test(fieldBlob);

  const noFileInput = (snap.fileInputCount || 0) === 0;
  const noPassword = (snap.passwordFieldCount || 0) === 0;

  if (hasApplyFields || !noPassword) return false;
  if ((snap.fileInputCount || 0) > 0) return false;

  // Known ATS board hosts at company root (no deep job/application path).
  if (atsBoardHost && !deepJobPath && noFileInput) {
    if (allSelects || filterFields || openPositions || fields.length === 0) return true;
    // Greenhouse/Lever boards often expose 2–4 filter selects with Location/Department labels.
    if (selectFields.length >= 2 && fields.length <= 8) return true;
  }

  if (filterFields && fields.length >= 2 && noFileInput) return true;
  if (openPositions && allSelects && fields.length >= 2 && noFileInput) return true;
  if (openPositions && selectFields.length >= 2 && noFileInput && !hasApplyFields) return true;

  return false;
}

/**
 * Job detail / deep application URL — not a company board index.
 * Used to stop soft board-ish signals (nav "All jobs") from hijacking Stagehand on JDs.
 */
export function pathLooksLikeJobDetail(snapOrUrl) {
  const url = typeof snapOrUrl === "string" ? snapOrUrl : String(snapOrUrl?.url || "");
  if (!url) return false;
  let host = "";
  let pathname = "";
  let pathAndQuery = "";
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    pathname = u.pathname || "/";
    pathAndQuery = `${u.pathname}${u.search}`;
  } catch {
    pathAndQuery = url;
    pathname = url.split(/[?#]/)[0] || "";
  }
  if (JOB_BOARD_JOB_PATH_RE.test(pathAndQuery)) return true;
  const parts = pathname.split("/").filter(Boolean);
  if (JOB_BOARD_HOST_RE.test(host) && parts.length >= 2) return true;
  // Aggregator / niche boards: /id/slug or /company/role-slug (2+ segments).
  if (parts.length >= 2) return true;
  return false;
}

function fieldsNameBlob(snap) {
  return (snap?.fields || []).map((f) => f.name || "").join(" ").toLowerCase();
}

export function blobFromCandidate(candidate) {
  if (!candidate) return "";
  return `${candidate.text || ""} ${candidate.aria || ""} ${candidate.testId || ""}`.trim();
}

export function textSuggestsFileUpload(text) {
  const blob = String(text || "");
  return FILE_UPLOAD_TEXT.test(blob) || FILE_INPUT_HINT_TEXT.test(blob);
}

export function candidateSuggestsFileUpload(candidate) {
  return textSuggestsFileUpload(blobFromCandidate(candidate));
}

/** Resume-choice wizard step — pick resume path before upload UI is shown. */
export function isResumeChoiceStep(snap) {
  const top = snap?.modalCandidates?.[0];
  if (!top) return false;
  const blob = blobFromCandidate(top).toLowerCase();
  if (/\bi have a resume\b|\bhave a resume\b|\bneed a resume\b|wizard-option/i.test(blob)) return true;
  if (/continue-with-email|wizard-option|modal-cta/i.test(`${top.testId || ""} ${top.selector || ""}`)) return true;
  return false;
}

export function snapSuggestsFileUpload(snap) {
  if (!snap) return false;
  if ((snap.fileInputCount || 0) > 0) return true;

  if (textSuggestsFileUpload(snap.applyModalTitle)) return true;

  for (const c of snap.modalCandidates || []) {
    if (candidateSuggestsFileUpload(c)) return true;
  }
  for (const c of snap.continueCandidates || []) {
    if (candidateSuggestsFileUpload(c)) return true;
  }

  return false;
}

export function uploadAlreadySucceeded(history) {
  return (history || []).some((h) => h.action === "upload_resume" && h.ok);
}

/** Preferences gate signup CTA was clicked this session. */
export function preferencesSignupSubmitted(history = []) {
  return (history || []).some((h) => h.ok && h.preferencesSignup === true);
}

/** Signup CTA clicked within the last N history entries (page may still be transitioning). */
export function recentPreferencesSignup(history = [], within = 4) {
  return (history || []).slice(-within).some((h) => h.ok && h.preferencesSignup === true);
}

/** Listing apply CTA already succeeded on this page fingerprint (click_apply or learned entry act). */
export function applyEntrySucceeded(history = [], fingerprint = "") {
  return (history || []).some((h) => {
    if (!h.ok) return false;
    // No-progress clicks must not suppress further entry / Stagehand retries.
    if (h.progress === false) return false;
    if (fingerprint && h.fromFingerprint && h.fromFingerprint !== fingerprint) return false;
    if (h.action === "click_apply") return true;
    if (h.action === "act" && h.applyStep === "entry") return true;
    return false;
  });
}

export function countRecentAction(history, action, n = 3) {
  return (history || []).slice(-n).filter((h) => h.action === action).length;
}

/** Recent upload_resume attempts all failed — escape upload-only loop. */
export function uploadStalled(history, minFailures = 2) {
  if (uploadAlreadySucceeded(history)) return false;
  const attempts = (history || []).filter((h) => h.action === "upload_resume").slice(-4);
  if (attempts.length < minFailures) return false;
  return attempts.slice(-minFailures).every((h) => !h.ok);
}

/** Inline apply form (Ashby Application tab) — fields on page, not a modal wizard. */
export function looksLikeInlineApplicationForm(snap) {
  if (!snap) return false;
  const stack = snap.dialogStack || [];
  const inRealDialog = stack.some((d) => d.inApplyModal) && (snap.modalCount || 0) > 0;
  if (inRealDialog && (snap.modalStepCount || 0) > 1) return false;

  const fields = snap.fields || [];
  const hasTextFields = fields.some((f) =>
    /text|email|tel|textarea/i.test(String(f.type || "")),
  );
  const hasFile = (snap.fileInputCount || 0) > 0;
  const onApplicationUrl = /\/application\b/i.test(String(snap.url || ""));

  return hasTextFields && hasFile && (onApplicationUrl || (snap.fieldCount || 0) >= 3);
}

/** Unfilled identity / application text fields on the current surface. */
export function hasUnfilledApplicationFields(snap, fillResult = null) {
  if (!snap) return false;
  const unfilledCustom = (snap.customControls || []).filter(
    (c) => !c.filled && ["yesno", "radio"].includes(c.widgetType),
  );
  if (unfilledCustom.length >= 1) return true;

  const fields = snap.fields || [];
  const textLike = fields.filter((f) => !/select|file|hidden|checkbox|radio/i.test(String(f.type || "")));
  const unfilled = textLike.filter((f) => !f.filled);
  if (unfilled.length >= 1) return true;
  const filledCount = fillResult?.filled?.length || 0;
  return (snap.fieldCount || 0) >= 2 && filledCount === 0;
}

export function shouldPreferUpload(snap, history, fillResult = null) {
  if (uploadAlreadySucceeded(history)) return false;
  if (uploadStalled(history)) return false;
  if (looksLikeInlineApplicationForm(snap) && hasUnfilledApplicationFields(snap, fillResult)) return false;
  if (isResumeChoiceStep(snap) && (snap?.fileInputCount || 0) === 0) return false;
  if ((snap?.fileInputCount || 0) > 0) return true;
  if (!snapSuggestsFileUpload(snap)) return false;

  const failedModalClicks = (history || []).filter((h) => h.action === "click_modal" && h.ok === false).length;
  const repeatedModal = countRecentAction(history, "click_modal", 2) >= 2;
  return failedModalClicks > 0 || repeatedModal || snapSuggestsFileUpload(snap);
}

export function isStuck(history, snap) {
  if (!history?.length || history.length < 3) return false;

  const fp = pageFingerprintFromSnap(snap);
  const recent = history.slice(-3);
  if (recent.every((h) => h.fingerprint === fp && !h.progress)) return true;

  const sameAction = recent[0]?.action;
  if (sameAction && recent.every((h) => h.action === sameAction) && !recent.some((h) => h.ok && h.progress)) {
    return true;
  }

  return false;
}

export function pageFingerprintFromSnap(snap) {
  if (!snap) return "";
  return [
    snap.pageKind,
    snap.fieldCount,
    snap.entryCount,
    snap.modalStepCount || 0,
    snap.fileInputCount || 0,
    snap.continueCount,
    snap.cookieBanner ? 1 : 0,
    snap.hasBlockingOverlay ? 1 : 0,
    snap.modalCandidates?.[0]?.text?.slice(0, 20) || "",
    snap.url?.split("?")[0]?.slice(-40),
  ].join("|");
}

export function computeApplyOutcome({ pipeline, error = null, stopped = false }) {
  const filled = pipeline?.fillResult?.filled?.length || 0;
  const resumeUploaded = (pipeline?.agentHistory || []).some((h) => h.action === "upload_resume" && h.ok);
  const fieldCount = pipeline?.snap?.fieldCount || 0;
  const pageKind = pipeline?.snap?.pageKind || "unknown";
  const hostname = (() => {
    try {
      return new URL(pipeline?.snap?.url || "").hostname;
    } catch {
      return "";
    }
  })();

  if (stopped) {
    return { outcome: "stopped", filled, resume_uploaded: resumeUploaded, field_count: fieldCount, page_kind: pageKind, hostname };
  }
  if (error) {
    return { outcome: "error", filled, resume_uploaded: resumeUploaded, field_count: fieldCount, page_kind: pageKind, hostname, error };
  }

  const reachedForm = filled >= 2 || (fieldCount >= 2 && filled > 0);
  const reachedSurface = pageKind === "form" || pageKind === "modal" || fieldCount > 0 || resumeUploaded;

  if (reachedForm || (filled > 0 && resumeUploaded)) {
    return { outcome: "ready", filled, resume_uploaded: resumeUploaded, field_count: fieldCount, page_kind: pageKind, hostname };
  }
  if (reachedSurface || filled > 0) {
    return { outcome: "partial", filled, resume_uploaded: resumeUploaded, field_count: fieldCount, page_kind: pageKind, hostname };
  }

  const stuck = isStuck(pipeline?.agentHistory || [], pipeline?.snap);
  return {
    outcome: stuck ? "stuck" : "partial",
    filled,
    resume_uploaded: resumeUploaded,
    field_count: fieldCount,
    page_kind: pageKind,
    hostname,
  };
}

export function outcomeJobStatus(outcome) {
  if (outcome === "ready" || outcome === "partial") return "browser_ready";
  return null;
}
