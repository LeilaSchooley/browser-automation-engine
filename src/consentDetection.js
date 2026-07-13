/**
 * Cookie consent vs non-cookie popup classification.
 */
import { COOKIE_TEXT, NON_COOKIE_POPUP_BODY } from "./patterns/consent.js";
import { blobFromCandidate, isJobAlertInterstitial } from "./heuristics.js";

export function consentPageBlob(snap) {
  const fieldLabels = (snap?.fields || [])
    .map((f) => `${f.label || ""} ${f.name || ""} ${f.placeholder || ""}`)
    .join(" ");
  return [snap?.pageText, snap?.title, fieldLabels, ...(snap?.overlayHints || [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** Newsletter / job-alert / phlex-style overlays — not cookie consent. */
export function isNonCookiePopup(snap) {
  if (!snap) return false;
  if (isJobAlertInterstitial(snap)) return true;
  const blob = consentPageBlob(snap);
  if (!NON_COOKIE_POPUP_BODY.test(blob)) return false;
  return (snap.fieldCount || 0) >= 2 || (snap.modalCount || 0) > 0 || !!snap.hasBlockingOverlay;
}

/** OneTrust / Funding Choices chrome visible (set during DOM scan). */
export function hasStructuralCookieChrome(snap) {
  return !!snap?.structuralCookieBanner;
}

/** Top scored cookie accept button (if any). */
export function topCookieCandidate(snap) {
  const candidates = snap?.cookieCandidates || [];
  return candidates.length ? candidates[0] : null;
}

export function topCookieCandidateScore(snap) {
  return topCookieCandidate(snap)?.score || 0;
}

/**
 * True only when there is evidence of real cookie consent UI —
 * not a mis-flagged job-alert or newsletter popup.
 */
export function looksLikeRealCookieConsent(snap) {
  if (!snap) return false;
  if (isNonCookiePopup(snap)) return false;

  const top = topCookieCandidate(snap);
  if (top && (top.score || 0) >= 60 && COOKIE_TEXT.test(blobFromCandidate(top))) return true;

  if (hasStructuralCookieChrome(snap) && top && (top.score || 0) >= 40) return true;

  return hasStructuralCookieChrome(snap) && !NON_COOKIE_POPUP_BODY.test(consentPageBlob(snap));
}

/** Consent accept attempted twice on same fingerprint without progress. */
export function consentFailedTwice(history = [], fingerprint = "") {
  if (!history?.length || !fingerprint) return false;
  const recent = history
    .slice(-4)
    .filter((h) => h.action === "accept_cookies" && h.fingerprint === fingerprint);
  return recent.length >= 2 && recent.every((h) => !h.ok || !h.progress);
}
