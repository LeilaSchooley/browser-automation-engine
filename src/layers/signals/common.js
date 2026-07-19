/** Shared text/blob helpers and file-upload surface signals. */

import { APPLICATION_FIELD_RE } from "../../patterns/listing.js";

export const FILE_UPLOAD_TEXT =
  /\b(upload\s+(a\s+)?resume|upload\s+(your\s+)?cv|attach\s+(a\s+)?resume|attach\s+cv|select\s+file|choose\s+file|browse\s+files?|import\s+resume|drag\s+(and\s+)?drop|add\s+resume|use\s+my\s+resume)\b/i;

export const FILE_INPUT_HINT_TEXT = /\b(uploader|file-input|resume-upload|cv-upload|file_upload)\b/i;

export function blobFromCandidate(candidate) {
  if (!candidate) return "";
  return `${candidate.text || ""} ${candidate.aria || ""} ${candidate.testId || ""}`.trim();
}

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
