/**
 * Tab hygiene for persistent / antidetect profiles (AdsPower, Multilogin).
 * Keeps one working page and closes blanks, ads, and abandoned siblings.
 */
import { normalizeHost } from "../host.js";
import { isSuspiciousApplyHost } from "./applyUrlSafety.js";

const AD_POPUP_HOST_RE =
  /doubleclick|googlesyndication|googleads|adservice|adsystem|taboola|outbrain|popads|propeller|onclicka|clickadu|adsterra|adnxs|criteo/i;

export function isBlankOrNewTabUrl(url = "") {
  const u = String(url || "").trim().toLowerCase();
  if (!u || u === "about:blank" || u === "about:newtab") return true;
  if (/^chrome:\/\/(newtab|new-tab-page)/i.test(u)) return true;
  if (/^edge:\/\/(newtab|new-tab-page)/i.test(u)) return true;
  if (u.startsWith("data:")) return true;
  return false;
}

function pageUrlSafe(page) {
  try {
    if (!page || page.isClosed()) return "";
    return page.url() || "";
  } catch {
    return "";
  }
}

/**
 * Close excess pages in a browser context, always preserving `keepPage`.
 * @param {import('playwright').BrowserContext} context
 * @param {import('playwright').Page|null} keepPage
 * @param {{ log?: object, closePrevious?: import('playwright').Page|null, maxPages?: number, layer?: string }} [opts]
 * @returns {Promise<{ closed: number, kept: number }>}
 */
export async function pruneExtraPages(context, keepPage, opts = {}) {
  const log = opts.log || null;
  const layer = opts.layer || "tabs";
  const maxPages = Math.max(1, opts.maxPages || 2);
  const closePrevious = opts.closePrevious || null;

  let pages = [];
  try {
    pages = (context?.pages?.() || []).filter((p) => p && !p.isClosed());
  } catch {
    return { closed: 0, kept: 0 };
  }
  if (!pages.length) return { closed: 0, kept: 0 };

  let closed = 0;

  async function closePage(page, reason) {
    if (!page || page.isClosed() || page === keepPage) return;
    const url = pageUrlSafe(page).slice(0, 90);
    try {
      await page.close({ runBeforeUnload: false });
      closed += 1;
      log?.layer(layer, `closed tab (${reason}): ${url || "blank"}`, "debug");
    } catch {
      /* ignore */
    }
  }

  if (closePrevious && closePrevious !== keepPage) {
    await closePage(closePrevious, "abandoned after tab switch");
  }

  // Refresh list after previous close.
  try {
    pages = (context.pages() || []).filter((p) => p && !p.isClosed());
  } catch {
    pages = [];
  }

  for (const page of pages) {
    if (page === keepPage) continue;
    const url = pageUrlSafe(page);
    if (isBlankOrNewTabUrl(url)) {
      await closePage(page, "blank");
      continue;
    }
    if (AD_POPUP_HOST_RE.test(url) || isSuspiciousApplyHost(normalizeHost(url))) {
      await closePage(page, "ad/suspicious");
    }
  }

  try {
    pages = (context.pages() || []).filter((p) => p && !p.isClosed());
  } catch {
    pages = [];
  }

  // Cap total open tabs (keep active + newest extras until under max).
  if (pages.length > maxPages) {
    const extras = pages.filter((p) => p !== keepPage);
    // Close oldest first (pages() order is roughly open order).
    const overflow = extras.slice(0, Math.max(0, pages.length - maxPages));
    for (const page of overflow) {
      await closePage(page, "over tab cap");
    }
  }

  let kept = 0;
  try {
    kept = (context.pages() || []).filter((p) => p && !p.isClosed()).length;
  } catch {
    kept = keepPage && !keepPage.isClosed() ? 1 : 0;
  }

  if (closed > 0) {
    log?.layer(layer, `tab cleanup — closed ${closed}, open ${kept}`, "info");
  }

  return { closed, kept };
}

/**
 * Pick a single working page for a CDP/persistent session and close the rest.
 * Prefer an existing blank tab so AdsPower doesn't spawn yet another window.
 * @param {import('playwright').BrowserContext} context
 * @param {{ log?: object }} [opts]
 */
export async function prepareWorkingPage(context, opts = {}) {
  const log = opts.log || null;
  let pages = [];
  try {
    pages = (context?.pages?.() || []).filter((p) => p && !p.isClosed());
  } catch {
    pages = [];
  }

  let page =
    pages.find((p) => isBlankOrNewTabUrl(pageUrlSafe(p))) ||
    pages[0] ||
    null;

  if (!page) {
    page = await context.newPage();
  }

  await pruneExtraPages(context, page, { log, maxPages: 1, layer: "tabs" });

  try {
    await page.bringToFront();
  } catch {
    /* ignore */
  }

  return page;
}
