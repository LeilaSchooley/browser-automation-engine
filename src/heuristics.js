/** Dynamic text/heuristic helpers — no site-specific selectors. */

export const FILE_UPLOAD_TEXT =
  /\b(upload\s+(a\s+)?resume|upload\s+(your\s+)?cv|attach\s+(a\s+)?resume|attach\s+cv|select\s+file|choose\s+file|browse\s+files?|import\s+resume|drag\s+(and\s+)?drop|add\s+resume|use\s+my\s+resume)\b/i;

export const FILE_INPUT_HINT_TEXT = /\b(uploader|file-input|resume-upload|cv-upload|file_upload)\b/i;

/** Secondary actions that dismiss an interstitial / upsell (any site). */
export const INTERSTITIAL_DISMISS_TEXT =
  /^(skip|no[, ]?thanks|not now|maybe later|continue without|dismiss|close|no,? pass|i'?ll pass|skip (for )?now|continue to (apply|job)|no,? i'?m good)$/i;

/** Copy that means "this dialog is an upsell/paywall, not the application". */
export const INTERSTITIAL_UPSELL_BODY =
  /\b(auto-?rejected|won[\u2019']?t reach a human|ats software will filter|fix my resume|quick wins to improve|successful candidates score|get more replies|upgrade (now|your)|go premium|subscribe|newsletter signup|paywall)\b/i;

/** @deprecated use INTERSTITIAL_UPSELL_BODY */
export const RESUME_REVIEW_UPSELL_TEXT = INTERSTITIAL_UPSELL_BODY;

/** True when a non-apply dialog is blocking (upsell, score tease, sponsored modal). */
export function isBlockingInterstitial(snap) {
  if (!snap) return false;
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
    (snap.dismissCandidates || []).some((c) => INTERSTITIAL_DISMISS_TEXT.test(String(c.text || "").trim())) ||
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
