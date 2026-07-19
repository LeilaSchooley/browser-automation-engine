/** Interstitial / upsell / apply-wizard surface signals. */

import {
  blobFromCandidate,
  candidateSuggestsFileUpload,
  hasApplicationSurfaceFields,
  isResumeChoiceStep,
  modalTextBlob,
} from "./common.js";
import { isJobAlertInterstitial } from "./listingSurface.js";

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

/** Behavioral wizard signals — file upload, resume choice, application continuation. */
export const APPLY_WIZARD_SIGNALS =
  /continue application|upload resume|start your application|i have a resume|attach resume|choose resume|wizard-option|modal-cta/i;

/** Post-upload optional review gate — behavioral: score tease + dismissible CTA, not workflow. */
export function isExpertReviewGate(snap) {
  return EXPERT_REVIEW_GATE_TEXT.test(modalTextBlob(snap));
}

export function textMatchesInterstitialDismiss(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (SKIP_FREE_EXPERT_REVIEW_PATTERN.test(t)) return true;
  if (SKIP_AND_CONTINUE_PATTERN.test(t)) return true;
  if (INTERSTITIAL_DISMISS_TEXT.test(t)) return true;
  return INTERSTITIAL_DISMISS_PATTERNS.some((p) => p.test(t));
}

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
