/**
 * Public page inspection API — inspectPage, logging, progress helpers.
 */
import { getSettings } from "../../runtime.js";
import { isActiveApplyWizard, isBlockingInterstitial, pageFingerprintFromSnap } from "../../heuristics.js";
import { mergeOverlaySnap, scanBlockingOverlays } from "../adDismiss.js";
import { isNonCookiePopup } from "../../consentDetection.js";
import { pageStateSummary } from "../pageState.js";
import { emptySnap, scanDom } from "./scanDom.js";
import { enrichViaPlaywright } from "./enrichSnap.js";

export { scoreEntryCandidate, scoreListingEntryCandidate } from "./candidateScoring.js";
export { applyAffordances } from "../applyStep.js";

export async function inspectPage(page) {
  let snap;
  try {
    const listingMode = getSettings().listing_mode !== false;
    snap = await scanDom(page, { listingMode });
  } catch (exc) {
    snap = emptySnap(page, exc.message);
  }
  snap = await enrichViaPlaywright(page, snap);
  try {
    mergeOverlaySnap(snap, await scanBlockingOverlays(page));
  } catch {
    /* overlay scan optional */
  }
  if (isNonCookiePopup(snap)) {
    snap.cookieBanner = false;
    snap.structuralCookieBanner = false;
  }
  return snap;
}

export function logPageSnapshot(log, snap, layer = "inspect", classification = null, pageState = null) {
  const stepInfo = classification
    ? ` step=${classification.step} conf=${classification.confidence}`
    : "";
  log.layer(layer, `url=${snap.url}`);
  log.layer(
    layer,
    `title="${snap.title}" fields=${snap.fieldCount} kind=${snap.pageKind || "?"} body=${snap.bodyTextLength || 0}ch${stepInfo}`,
  );
  const layout = pageState || pageStateSummary(snap);
  if (layout.uiPhase && layout.uiPhase !== "idle") {
    log.layer(layer, `  layout phase=${layout.uiPhase} dialogs=${layout.dialogStackDepth || 0} picker=${layout.pickerOpen ? "open" : "closed"}`, "info");
  }
  if (layout.pendingCommits?.length) {
    for (const p of layout.pendingCommits.slice(0, 3)) {
      log.layer(layer, `  pending: ${p}`, "warn");
    }
  }
  if (snap.inspectVia) log.layer(layer, `  inspect: ${snap.inspectVia} enrichment`, "info");
  if (snap.error) log.layer(layer, `  scan error: ${snap.error}`, "warn");
  if (snap.cookieBanner) log.layer(layer, "  cookie banner visible", "info");
  if (snap.cookieCandidates?.length) {
    for (const c of snap.cookieCandidates.slice(0, 3)) {
      log.layer(layer, `  cookie: "${c.text}" score=${c.score}`, "info");
    }
  }
  if (snap.entryCount) {
    for (const e of snap.entryCandidates || []) {
      const tid = e.testId ? ` testid=${e.testId}` : "";
      log.layer(layer, `  entry: <${e.tag}> "${e.text}" score=${e.score}${tid}`, "info");
    }
  }
  if (snap.hasApplyModal) {
    log.layer(layer, `  apply modal: "${snap.applyModalTitle || "open"}" (${snap.modalStepCount || 0} step(s))`, "info");
    for (const m of snap.modalCandidates || []) {
      log.layer(layer, `  modal: "${m.text}" score=${m.score}${m.testId ? ` testid=${m.testId}` : ""}`, "info");
    }
  }
  if (snap.modalCount && !snap.hasApplyModal) log.layer(layer, `  modals/overlays: ${snap.modalCount}`, "info");
  if (snap.hasBlockingOverlay) {
    log.layer(
      layer,
      `  blocking overlay${snap.bodyLocked ? " (body locked)" : ""}${snap.overlayHints?.length ? `: ${snap.overlayHints.join(", ")}` : ""}`,
      "info",
    );
    for (const d of snap.dismissCandidates || []) {
      log.layer(layer, `  dismiss: "${d.text || d.aria || "?"}" score=${d.score}${d.source ? ` src=${d.source}` : ""}`, "info");
    }
  } else if (classification?.step === "overlay" || isBlockingInterstitial(snap)) {
    log.layer(layer, "  interstitial likely (no hasBlockingOverlay flag)", "info");
    for (const d of (snap.dismissCandidates || []).slice(0, 4)) {
      log.layer(layer, `  dismiss candidate: "${d.text || d.aria || "?"}" score=${d.score || "?"}`, "info");
    }
  }
  if (isActiveApplyWizard(snap) && (classification?.step === "overlay" || isBlockingInterstitial(snap))) {
    log.layer(layer, "  note: apply wizard active — upsell classification suppressed", "info");
  }
  if (snap.continueCount) {
    for (const b of snap.continueCandidates || []) {
      log.layer(layer, `  continue: "${b.text}" score=${b.score}`, "info");
    }
  }
  if (snap.fileInputCount) {
    for (const f of snap.fileInputCandidates || []) {
      log.layer(layer, `  file input: ${f.selector}${f.testId ? ` testid=${f.testId}` : ""} score=${f.score}`, "info");
    }
  }
  for (const f of snap.fields || []) {
    log.layer(layer, `  field: ${f.type} "${f.label || f.name || f.id || "?"}"`);
  }
}

export function pageFingerprint(snap) {
  return pageFingerprintFromSnap(snap);
}

export function progressScore(snap, fillResult) {
  const filled = fillResult?.filled?.length || 0;
  let score = filled * 10 + (snap.fieldCount || 0) * 2;
  if (snap.pageKind === "form") score += 15;
  if (snap.pageKind === "modal") score += 8;
  if (snap.fileInputCount) score += 5;
  if (snap.pageKind === "listing") score += 3;
  if (snap.entryCount) score += snap.entryCandidates[0]?.score || 0;
  return score;
}

export function looksLikeApplyForm(snap, minFields = 2) {
  return (snap.fieldCount || 0) >= minFields;
}

export function topEntryCandidate(snap) {
  return snap?.entryCandidates?.[0] || null;
}

export function topCookieCandidate(snap) {
  return snap?.cookieCandidates?.[0] || null;
}
