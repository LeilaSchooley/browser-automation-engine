import { humanPause } from "../human.js";
import { inspectPage } from "./formDiscovery.js";
import { normalizeHost } from "../host.js";
import { isBrowserUnreachablePage, isSuspiciousApplyHost } from "./applyUrlSafety.js";
import { isBlankOrNewTabUrl, pruneExtraPages } from "./tabHygiene.js";

export function isPageUnloaded(snap) {
  if (!snap) return true;
  const title = (snap.title || "").trim();
  if ((snap.modalStepCount || 0) > 0 || snap.hasApplyModal) return false;
  if ((snap.entryCount || 0) > 0) return false;
  if (snap.cookieBanner) return false;
  if (snap.pageKind === "listing" || snap.pageKind === "form" || snap.pageKind === "modal") return false;
  if ((snap.bodyTextLength || 0) > 500) return false;
  return snap.pageKind === "unknown" && (snap.fieldCount || 0) === 0 && title.length < 5;
}

const AD_POPUP_HOST_RE =
  /doubleclick|googlesyndication|googleads|adservice|adsystem|taboola|outbrain|popads|propeller|onclicka|clickadu|adsterra|adnxs|criteo/i;

/**
 * After a click, check whether a new tab/popup opened and adopt it when it looks
 * like the apply flow continued there (apply links with target=_blank, redirect
 * chains). Ad popups are closed; unknown tabs are only adopted when the current
 * page itself did not navigate.
 * @returns {Promise<import("playwright").Page|null>} the adopted page or null
 */
export async function adoptOpenedPage(page, knownPages, log, layer = "agent") {
  let pages = [];
  try {
    pages = page.context().pages();
  } catch {
    return null;
  }
  const fresh = pages.filter((p) => p !== page && !knownPages.has(p) && !p.isClosed());
  if (!fresh.length) return null;

  let adopted = null;
  for (const candidate of fresh.reverse()) {
    let url = "";
    try {
      await candidate.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
      url = candidate.url();
    } catch {
      continue;
    }
    if (!/^https?:/i.test(url)) {
      if (isBlankOrNewTabUrl(url) || isBrowserUnreachablePage({ url, title: await candidate.title().catch(() => "") })) {
        log?.layer(layer, `closing unreachable tab ${url.slice(0, 90)}`, "warn");
        await candidate.close().catch(() => {});
      }
      continue;
    }
    if (isSuspiciousApplyHost(normalizeHost(url))) {
      log?.layer(layer, `closing suspicious apply tab ${url.slice(0, 90)}`, "warn");
      await candidate.close().catch(() => {});
      continue;
    }
    if (AD_POPUP_HOST_RE.test(url)) {
      log?.layer(layer, `closing ad popup ${url.slice(0, 90)}`, "debug");
      await candidate.close().catch(() => {});
      continue;
    }
    if (!adopted) {
      try {
        await candidate.bringToFront();
      } catch {
        /* ignore */
      }
      log?.layer(layer, `following new tab → ${url.slice(0, 120)}`, "info");
      adopted = candidate;
    } else {
      // Extra apply-ish tabs after the one we adopted — close to keep AdsPower tidy.
      log?.layer(layer, `closing extra tab ${url.slice(0, 90)}`, "debug");
      await candidate.close().catch(() => {});
    }
  }

  if (adopted) {
    await pruneExtraPages(page.context(), adopted, {
      log,
      closePrevious: page,
      maxPages: 2,
      layer,
    });
  }

  return adopted;
}

/** Wait for dialog/form to appear after a click action. */
export async function waitAfterClickTransition(page) {
  await page
    .locator(
      "[role='dialog'][aria-modal='true'], .modal, [aria-modal='true'], [data-testid*='option-upload' i], [data-testid*='upload-resume' i], input:not([type='hidden']), input[type='file']",
    )
    .first()
    .waitFor({ state: "visible", timeout: 6000 })
    .catch(() => {});
  await humanPause(800, 1400);
}

/**
 * Poll DOM scan until page has meaningful content or apply/cookie controls.
 */
export async function waitForApplySurface(page, log, { timeoutMs = 28000 } = {}) {
  const started = Date.now();
  let lastSnap = null;
  let polls = 0;

  log?.layer("page_ready", `scanning DOM (up to ${Math.round(timeoutMs / 1000)}s)…`, "info");

  while (Date.now() - started < timeoutMs) {
    polls += 1;

    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 2000 }).catch(() => {});
      await page.waitForLoadState("load", { timeout: 2000 }).catch(() => {});
      if (polls % 3 === 0) {
        await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => {});
      }
    } catch {
      /* CDP */
    }

    const snap = await inspectPage(page);
    lastSnap = snap;

    if (!isPageUnloaded(snap) || (snap.modalStepCount || 0) > 0 || (snap.fieldCount || 0) > 0) {
      log?.layer(
        "page_ready",
        `ready after ${polls} scan(s) (${Date.now() - started}ms) kind=${snap.pageKind} entry=${snap.entryCount} fields=${snap.fieldCount} modal=${snap.modalStepCount || 0}`,
        "info",
      );
      return snap;
    }

    if (polls % 4 === 0 && !lastSnap?.hasApplyModal) {
      await page.evaluate(() => {
        window.scrollTo(0, Math.min(600, document.body?.scrollHeight || 600));
      }).catch(() => {});
    }

    await humanPause(450, 700);
  }

  log?.layer("page_ready", `scan timeout after ${polls} attempts`, "warn");
  return lastSnap || (await inspectPage(page));
}
