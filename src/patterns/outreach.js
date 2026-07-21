/**
 * Outreach / Reach-out modal patterns — message + optional location-mismatch ack.
 * Shared by WaaS job-page Reach out and similar “message the founder” gates.
 */

/** Job-detail Reach out / Share surfaces (WaaS /jobs/:id modal). */
export const REACH_OUT_URL_RE = /workatastartup\.com\/jobs\/\d+/i;

/** Copy that identifies the outreach composer (not profile wizard). */
export const REACH_OUT_COPY_RE =
  /reach out to|here.?s a little bit about me|please write at least\s*\d+\s*characters|by applying, you acknowledge/i;

/** Conditional “job ≠ location prefs” checkbox on Reach out. */
export const LOCATION_MISMATCH_RE =
  /doesn.?t match your location|open to relocating|we.?ll update your profile|role doesn.?t match|this role is in.{0,40}(but|and).{0,40}(you|your)/i;

/** Send / submit CTAs for outreach (not profile Continue). */
export const OUTREACH_SEND_RE = /^(send|submit|reach out)$/i;

export const MIN_OUTREACH_CHARS = 50;

/** WaaS Reach-out modal hard cap (textarea maxlength / visible counter). */
export const MAX_OUTREACH_CHARS = 580;

/**
 * Trim to maxLen on a word boundary when possible (avoid "I'm base…").
 * @param {string} text
 * @param {number} maxLen
 */
export function truncateOutreachMessage(text, maxLen = MAX_OUTREACH_CHARS) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  if (raw.length <= maxLen) return raw;
  const budget = Math.max(MIN_OUTREACH_CHARS, maxLen);
  let slice = raw.slice(0, budget);
  const lastSpace = slice.lastIndexOf(" ");
  // Prefer a clean word cut when we still keep ≥ min chars.
  if (lastSpace >= MIN_OUTREACH_CHARS) {
    slice = slice.slice(0, lastSpace).trimEnd();
  } else {
    slice = slice.trimEnd();
  }
  // Drop dangling half-words / punctuation leftovers.
  slice = slice.replace(/[,:;–—-]\s*$/, "").trimEnd();
  if (slice.length < MIN_OUTREACH_CHARS && raw.length >= MIN_OUTREACH_CHARS) {
    return raw.slice(0, budget).trimEnd();
  }
  return slice;
}

/**
 * Snap-level detector — no Playwright needed.
 * @param {object} snap
 */
export function looksLikeReachOutModal(snap) {
  if (!snap) return false;
  const url = String(snap.url || "");
  if (!REACH_OUT_URL_RE.test(url)) return false;

  const fields = snap.fields || [];
  const hasTextarea = fields.some((f) => /textarea/i.test(String(f.type || "")));
  if (!hasTextarea) return false;

  const pageText = `${snap.pageText || ""} ${snap.headings || ""} ${snap.title || ""}`;
  if (REACH_OUT_COPY_RE.test(pageText) || LOCATION_MISMATCH_RE.test(pageText)) return true;

  // Fallback: job URL + lone textarea (+ optional checkbox) after Apply opened the modal.
  const textareas = fields.filter((f) => /textarea/i.test(String(f.type || "")));
  const checkboxes = fields.filter((f) => /checkbox/i.test(String(f.type || "")));
  if (textareas.length >= 1 && textareas.length <= 2 && checkboxes.length <= 2) {
    // Prefer when an Apply entry still sits behind the modal (common WaaS shape).
    if ((snap.entryCount || 0) > 0 || (snap.fieldCount || 0) <= 4) return true;
  }
  return false;
}

/**
 * Unlabeled lone textarea on a Send surface → treat as required outreach.
 * @param {object} snap
 */
export function looksLikeRequiredOutreachTextarea(snap) {
  if (!looksLikeReachOutModal(snap)) return false;
  const textareas = (snap.fields || []).filter((f) => /textarea/i.test(String(f.type || "")));
  return textareas.some((f) => !f.filled && !String(f.value || "").trim());
}
