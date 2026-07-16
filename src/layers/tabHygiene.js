/**
 * Tab hygiene for persistent / antidetect profiles (AdsPower, Multilogin).
 * Keeps one working page and closes blanks, ads, and abandoned siblings.
 * Never closes employer ATS tabs (Lever, Greenhouse, Ashby, Workday, …).
 */
import { normalizeHost } from "../host.js";
import {
  isOauthProviderHost,
  isSuspiciousApplyHost,
  isEmployerAtsUrl,
  isBoardOnboardUrl,
} from "./applyUrlSafety.js";

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

function closePriority(url) {
  if (isBlankOrNewTabUrl(url)) return 0;
  if (AD_POPUP_HOST_RE.test(url) || isSuspiciousApplyHost(normalizeHost(url))) return 1;
  if (isBoardOnboardUrl(url)) return 2;
  if (isOauthProviderHost(url)) return 3;
  if (isEmployerAtsUrl(url)) return 100; // never preferred for close
  return 50;
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
    const url = pageUrlSafe(page);
    if (isEmployerAtsUrl(url)) {
      log?.layer(layer, `keeping ATS tab (skip close): ${url.slice(0, 90)}`, "info");
      return;
    }
    try {
      await page.close({ runBeforeUnload: false });
      closed += 1;
      log?.layer(layer, `closed tab (${reason}): ${url.slice(0, 90) || "blank"}`, "debug");
    } catch {
      /* ignore */
    }
  }

  if (closePrevious && closePrevious !== keepPage) {
    await closePage(closePrevious, "abandoned after tab switch");
  }

  try {
    pages = (context.pages() || []).filter((p) => p && !p.isClosed());
  } catch {
    pages = [];
  }

  for (const page of pages) {
    if (page === keepPage) continue;
    const url = pageUrlSafe(page);
    if (isEmployerAtsUrl(url)) continue;
    if (isBlankOrNewTabUrl(url)) {
      await closePage(page, "blank");
      continue;
    }
    if (AD_POPUP_HOST_RE.test(url) || isSuspiciousApplyHost(normalizeHost(url))) {
      await closePage(page, "ad/suspicious");
      continue;
    }
    if (isOauthProviderHost(url)) {
      await closePage(page, "sso-popup");
      continue;
    }
    if (isBoardOnboardUrl(url)) {
      await closePage(page, "board-onboard");
    }
  }

  try {
    pages = (context.pages() || []).filter((p) => p && !p.isClosed());
  } catch {
    pages = [];
  }

  // Cap total open tabs — close lowest-value extras first; never ATS.
  if (pages.length > maxPages) {
    const extras = pages
      .filter((p) => p !== keepPage)
      .map((p) => ({ page: p, url: pageUrlSafe(p), priority: closePriority(pageUrlSafe(p)) }))
      .filter((e) => !isEmployerAtsUrl(e.url))
      .sort((a, b) => a.priority - b.priority || 0);

    let need = pages.length - maxPages;
    // Prefer closing onboard/ads; if only ATS+keep remain, allow over-cap.
    for (const { page } of extras) {
      if (need <= 0) break;
      const before = closed;
      await closePage(page, "over tab cap");
      if (closed > before) need -= 1;
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
 * Prefer an existing ATS tab as the working page when present.
 * @param {import('playwright').BrowserContext} context
 * @param {import('playwright').Page|null} current
 * @returns {Promise<import('playwright').Page|null>}
 */
export async function preferAtsWorkingPage(context, current = null) {
  let pages = [];
  try {
    pages = (context?.pages?.() || []).filter((p) => p && !p.isClosed());
  } catch {
    return current;
  }
  const ats = [...pages].reverse().find((p) => isEmployerAtsUrl(pageUrlSafe(p)));
  if (!ats || ats === current) return current || ats || null;
  try {
    await ats.bringToFront();
  } catch {
    /* ignore */
  }
  return ats;
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
    pages.find((p) => isEmployerAtsUrl(pageUrlSafe(p))) ||
    pages.find((p) => isBlankOrNewTabUrl(pageUrlSafe(p))) ||
    pages[0] ||
    null;

  if (!page) {
    page = await context.newPage();
  }

  await pruneExtraPages(context, page, { log, maxPages: 2, layer: "tabs" });

  try {
    await page.bringToFront();
  } catch {
    /* ignore */
  }

  return page;
}
