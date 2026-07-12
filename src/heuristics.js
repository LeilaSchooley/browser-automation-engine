/** Dynamic text/heuristic helpers — no site-specific selectors. */

export const FILE_UPLOAD_TEXT =
  /\b(upload\s+(a\s+)?resume|upload\s+(your\s+)?cv|attach\s+(a\s+)?resume|attach\s+cv|select\s+file|choose\s+file|browse\s+files?|import\s+resume|drag\s+(and\s+)?drop|add\s+resume|use\s+my\s+resume)\b/i;

export const FILE_INPUT_HINT_TEXT = /\b(uploader|file-input|resume-upload|cv-upload|file_upload)\b/i;

/** Post-upload expert review / resume polish gate (JobLeads and similar). */
export const EXPERT_REVIEW_GATE_TEXT =
  /\b(expert review|free expert review|resume is not ready yet|not ready yet\?|get a free expert)\b/i;

/** Flexible match for "Skip and continue" / "Skip & continue" (spacing varies in DOM). */
export const SKIP_AND_CONTINUE_PATTERN = /skip\s*(and|&)\s*continue/i;

/** Secondary actions that dismiss an interstitial / upsell (any site). */
export const INTERSTITIAL_DISMISS_TEXT =
  /^(skip|skip to (application|apply)|skip and continue|skip & continue|no[, ]?thanks|not now|maybe later|continue without( documents)?|dismiss|close|no,? pass|i'?ll pass|skip (for )?now|continue to (apply|job)|no,? i'?m good)$/i;

/** Playwright getByRole patterns — tried in order (most specific first). */
export const INTERSTITIAL_DISMISS_PATTERNS = [
  /^Skip and continue$/i,
  /^Skip & continue$/i,
  /skip\s*(and|&)\s*continue/i,
  /^Skip to application$/i,
  /^Skip to apply$/i,
  /^Skip$/i,
  /^Continue without documents$/i,
  /^Continue without$/i,
  /^No[, ]?thanks$/i,
  /^Not now$/i,
  /^Maybe later$/i,
  /^Dismiss$/i,
  /^Continue to (apply|job)$/i,
  /skip to (application|apply)/i,
];

/** Copy that means "this dialog is an upsell/paywall, not the application". */
export const INTERSTITIAL_UPSELL_BODY =
  /\b(auto-?rejected|won[\u2019']?t reach a human|ats software will filter|fix my resume|quick wins to improve|successful candidates score|increase your chances|tailor your resume|get more replies|expert review|free expert review|resume is not ready yet|not ready yet|upgrade (now|your)|go premium|subscribe|newsletter signup|paywall)\b/i;

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

/** Post-upload optional review gate — file may be attached but form is not open yet. */
export function isExpertReviewGate(snap) {
  return EXPERT_REVIEW_GATE_TEXT.test(modalTextBlob(snap));
}

/** Best dismiss/skip control on the page — prefers Skip and continue over weaker skips. */
export function findBestDismissCandidate(snap) {
  const pool = [];
  for (const c of snap?.dismissCandidates || []) {
    pool.push({ ...c, _text: c.text || c.aria || "" });
  }
  for (const i of snap?.interactives || []) {
    if (textMatchesInterstitialDismiss(i.text || i.aria)) {
      pool.push({ ...i, _text: i.text || i.aria || "", source: i.source || "interactive" });
    }
  }
  if (!pool.length) return null;
  const rank = (c) => {
    const t = String(c._text || "").toLowerCase();
    if (SKIP_AND_CONTINUE_PATTERN.test(t)) return 100;
    if (/skip to application|skip to apply/i.test(t)) return 90;
    if (/^skip$/i.test(t.trim())) return 80;
    if (/no[, ]?thanks|not now|maybe later/i.test(t)) return 70;
    if (/continue without/i.test(t)) return 15;
    return 50;
  };
  return pool.sort((a, b) => rank(b) - rank(a))[0];
}

/** Legitimate apply wizard (JobLeads umja, upload step) — not a marketing upsell. */
export function isActiveApplyWizard(snap) {
  if (isExpertReviewGate(snap)) return false;
  if (!snap?.hasApplyModal) return false;
  if ((snap.fileInputCount || 0) > 0) return true;
  if (isResumeChoiceStep(snap)) return true;

  const wizardMarkers = /continue application|upload resume|start your application|i have a resume|option-upload|upload-resume/i;
  if (wizardMarkers.test(snap.applyModalTitle || "")) return true;

  for (const c of snap.modalCandidates || []) {
    const blob = blobFromCandidate(c);
    if (wizardMarkers.test(blob)) return true;
    if (candidateSuggestsFileUpload(c)) return true;
  }

  for (const f of snap.fileInputCandidates || []) {
    if (/uploader|file-input|resume-upload/i.test(`${f.testId || ""} ${f.selector || ""}`)) return true;
  }

  return false;
}

export function textMatchesInterstitialDismiss(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (SKIP_AND_CONTINUE_PATTERN.test(t)) return true;
  if (INTERSTITIAL_DISMISS_TEXT.test(t)) return true;
  return INTERSTITIAL_DISMISS_PATTERNS.some((p) => p.test(t));
}

/** True when a non-apply dialog is blocking (upsell, score tease, sponsored modal). */
export function isBlockingInterstitial(snap) {
  if (!snap) return false;
  if (isActiveApplyWizard(snap)) return false;
  const hints = snap.overlayHints || [];
  if (hints.some((h) => /interstitial|resume-review-upsell|upsell/i.test(h))) return true;
  if ((snap.dismissCandidates || []).some((c) => /interstitial|upsell/i.test(c.source || ""))) return true;
  const blob = [
    snap.pageText,
    snap.title,
    snap.applyModalTitle,
    ...(snap.modalCandidates || []).map((c) => `${c.text || ""} ${c.testId || ""}`),
    ...(snap.dismissCandidates || []).map((c) => `${c.text || ""} ${c.testId || ""}`),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/[\u2018\u2019']/g, "'");
  if (!INTERSTITIAL_UPSELL_BODY.test(blob)) return false;
  return (
    (snap.modalCount || 0) > 0 ||
    (snap.dismissCandidates || []).some((c) => textMatchesInterstitialDismiss(c.text)) ||
    snap.hasBlockingOverlay
  );
}

export function isResumeReviewUpsell(snap) {
  return isBlockingInterstitial(snap);
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

/** JobLeads-style wizard: pick "I have a resume" before a file input exists. */
export function isResumeChoiceStep(snap) {
  const top = snap?.modalCandidates?.[0];
  if (!top) return false;
  const blob = blobFromCandidate(top).toLowerCase();
  if (/option-upload|upload-resume|have a resume|i have a resume/i.test(blob)) return true;
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

export function countRecentAction(history, action, n = 3) {
  return (history || []).slice(-n).filter((h) => h.action === action).length;
}

export function shouldPreferUpload(snap, history) {
  if (uploadAlreadySucceeded(history)) return false;
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
