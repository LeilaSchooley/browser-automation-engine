/**
 * Dynamic DOM inspection — walks light DOM + shadow roots, scores interactive
 * elements, returns click targets. No site-specific selectors in this layer.
 *
 * Thin barrel: implementation lives in perception/{scanDom,enrichSnap,inspectPage,candidateScoring}.
 */
export {
  scoreEntryCandidate,
  scoreListingEntryCandidate,
  inspectPage,
  applyAffordances,
  logPageSnapshot,
  pageFingerprint,
  progressScore,
  looksLikeApplyForm,
  topEntryCandidate,
  topCookieCandidate,
} from "./perception/inspectPage.js";
