/**
 * Google Funding Choices (fc-consent-root) — common on publisher job aggregators.
 */
import { humanPause } from "../human.js";

const FC_ROOT_SEL = ".fc-consent-root, [class*='fc-consent-root']";
const FC_OVERLAY_SEL = ".fc-dialog-overlay, [class*='fc-dialog-overlay']";

const CONSENT_BUTTON_PATTERNS = [
  /^consent$/i,
  /^accept$/i,
  /^agree$/i,
  /^allow$/i,
  /accept all/i,
  /agree and close/i,
  /i agree/i,
];

/** @param {import('playwright').Page} page */
export async function fundingChoicesVisible(page) {
  try {
    const root = page.locator(FC_ROOT_SEL).first();
    if (await root.isVisible({ timeout: 400 }).catch(() => false)) return true;
    const overlay = page.locator(FC_OVERLAY_SEL).first();
    return overlay.isVisible({ timeout: 400 }).catch(() => false);
  } catch {
    return false;
  }
}

/**
 * @param {import('playwright').Page} page
 * @param {{ layer?: Function }} [log]
 * @param {string} [layerName]
 */
export async function acceptFundingChoicesConsent(page, log = null, layerName = "page_prep") {
  if (!(await fundingChoicesVisible(page))) return false;

  const scope = page.locator(FC_ROOT_SEL).first();
  const hasRoot = (await scope.count().catch(() => 0)) > 0;

  for (const pattern of CONSENT_BUTTON_PATTERNS) {
    try {
      const searchRoot = hasRoot ? scope : page;
      const btn = searchRoot.getByRole("button", { name: pattern });
      if ((await btn.count()) > 0 && (await btn.first().isVisible({ timeout: 900 }).catch(() => false))) {
        await btn.first().click({ timeout: 6000 });
        log?.layer(layerName, `funding-choices: clicked button matching ${pattern}`, "info");
        await humanPause(600, 1100);
        return true;
      }
      const alt = searchRoot.locator("button, [role='button']").filter({ hasText: pattern });
      if ((await alt.count()) > 0 && (await alt.first().isVisible({ timeout: 900 }).catch(() => false))) {
        await alt.first().click({ timeout: 6000 });
        log?.layer(layerName, `funding-choices: clicked control matching ${pattern}`, "info");
        await humanPause(600, 1100);
        return true;
      }
    } catch {
      /* next pattern */
    }
  }

  return false;
}
