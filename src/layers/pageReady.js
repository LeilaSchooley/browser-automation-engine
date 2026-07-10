import { humanPause } from "../human.js";
import { inspectPage } from "./formDiscovery.js";

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

/** Wait for dialog/form to appear after a click action. */
export async function waitAfterClickTransition(page) {
  await page
    .locator(
      "[role='dialog'][aria-modal='true'], .ui-modal, [data-testid^='umja-'], [data-testid*='option-upload' i], input:not([type='hidden']), input[type='file']",
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
