/**
 * Dead listing / HTTP 404 / hosting error page detection.
 * Kept separate from applyUrlSafety ↔ applyUrlHealth to avoid circular imports.
 */

export const DEAD_LISTING_TITLE_RE =
  /^(404(\s+not\s+found)?|not\s+found|page\s+not\s+found|error\s*404|404\s+error|application\s+error)$/i;

export const DEAD_LISTING_BODY_RE =
  /\b404\s+not\s+found\b|\bpage\s+not\s+found\b|\bthis\s+page\s+(could\s+not\s+be\s+found|does\s+not\s+exist|doesn'?t\s+exist)\b|\bsomething\s+bad\s+happened\b|\bapplication\s+error\b|\bjob\s+(is\s+)?no\s+longer\s+available\b|\bposition\s+has\s+been\s+filled\b|\blisting\s+(has\s+been\s+)?removed\b|\bno\s+longer\s+accepting\s+applications\b|\bthe\s+train\s+has\s+not\s+arrived\s+at\s+the\s+station\b|\bdomain\s+has\s+(not\s+)?provisioned\b|\bapplication\s+not\s+found\b/i;

export const DEAD_LISTING_URL_RE = /\/404(?:\/|$|\?)|\/not[-_]?found(?:\/|$|\?)|\/error\/404(?:\/|$|\?)/i;

/**
 * True when the loaded page is a dead listing / 404 / empty hosting error — not an apply form.
 * @param {object} snap
 * @returns {{ dead: boolean, reason: string }}
 */
export function isDeadListingPage(snap) {
  if (!snap) return { dead: false, reason: "" };

  const url = String(snap.url || "");
  const title = String(snap.title || "").trim();
  const pageText = String(snap.pageText || snap.headings || "");
  const blob = `${title} ${pageText}`.toLowerCase();
  const bodyLen = Number(snap.bodyTextLength || pageText.replace(/\s+/g, " ").trim().length || 0);
  const fields = Number(snap.fieldCount || 0);
  const entries = Number(snap.entryCount || 0);
  const kind = String(snap.pageKind || "unknown");

  if (DEAD_LISTING_URL_RE.test(url)) {
    return { dead: true, reason: "404 / not-found URL path" };
  }

  // Title-only shells (WWR "Application Error", empty body) — no form to recover.
  if (
    fields === 0 &&
    entries === 0 &&
    (/application\s+error/i.test(title) ||
      /this\s+page\s+does\s+not\s+exist/i.test(title) ||
      DEAD_LISTING_TITLE_RE.test(title))
  ) {
    return { dead: true, reason: `HTTP error page (title: ${title.slice(0, 60)})` };
  }

  if (DEAD_LISTING_TITLE_RE.test(title)) {
    return { dead: true, reason: `HTTP error page (title: ${title.slice(0, 60)})` };
  }

  if (DEAD_LISTING_BODY_RE.test(blob) && fields < 2 && entries === 0) {
    const snippet = (blob.match(DEAD_LISTING_BODY_RE)?.[0] || "error page").slice(0, 80);
    return { dead: true, reason: `dead listing page (${snippet})` };
  }

  // Railway / free-host 404 shells: short body, no form, explicit Not Found copy.
  if (
    fields === 0 &&
    entries === 0 &&
    (kind === "unknown" || kind === "content") &&
    bodyLen > 0 &&
    bodyLen < 800 &&
    /\bnot\s+found\b|\b404\b|does\s+not\s+exist|something\s+bad\s+happened|train has not arrived|railway/i.test(blob)
  ) {
    return { dead: true, reason: "empty error / hosting 404 page (no apply form)" };
  }

  // Zero-body error shells (title may be empty briefly after nav).
  if (
    fields === 0 &&
    entries === 0 &&
    bodyLen === 0 &&
    (kind === "unknown" || kind === "content") &&
    /\/account(?:\/|$)|\/error(?:\/|$)/i.test(url) &&
    !/register|sign[-_]?up|login|sign[-_]?in/i.test(url)
  ) {
    return { dead: true, reason: "empty account/error shell (no apply form)" };
  }

  return { dead: false, reason: "" };
}
