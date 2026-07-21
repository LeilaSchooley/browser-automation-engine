/**
 * Commit open typeahead / combobox widgets so wizard validation unlocks Continue.
 */
import { humanPause } from "../human.js";

/**
 * If a suggestion listbox is open, pick the best option (or first).
 * Then blur the active control so Places / React Select commit.
 * @param {import('playwright').Page} page
 * @param {{ layer?: Function }|null} log
 * @returns {Promise<boolean>} true when any commit gesture ran
 */
export async function commitOpenTypeaheads(page, log = null) {
  if (!page) return false;
  let did = false;

  try {
    const listbox = page.locator("[role='listbox']:visible, .pac-container:visible").first();
    if ((await listbox.count().catch(() => 0)) > 0) {
      const options = page.locator(
        "[role='listbox'] [role='option'], [role='option']:visible, .pac-item:visible",
      );
      const n = await options.count().catch(() => 0);
      if (n > 0) {
        await options.first().click({ timeout: 2500 }).catch(async () => {
          await page.keyboard.press("Enter").catch(() => {});
        });
        did = true;
        log?.layer?.("wizard", "commit_step — selected open typeahead suggestion", "info");
        await humanPause(350, 600);
      } else {
        await page.keyboard.press("Enter").catch(() => {});
        did = true;
      }
    }
  } catch {
    /* ignore */
  }

  try {
    const active = page.locator(":focus");
    if ((await active.count().catch(() => 0)) > 0) {
      const tag = await active
        .evaluate((el) => el.tagName?.toLowerCase() || "")
        .catch(() => "");
      const role = await active.getAttribute("role").catch(() => "");
      const auto = await active.getAttribute("aria-autocomplete").catch(() => "");
      if (tag === "input" || tag === "textarea" || role === "combobox" || auto) {
        await page.keyboard.press("Tab").catch(() => {});
        await active.evaluate((el) => el.blur?.()).catch(() => {});
        did = true;
        log?.layer?.("wizard", "commit_step — blurred focused combobox/input", "info");
        await humanPause(250, 450);
      }
    }
  } catch {
    /* ignore */
  }

  // Click a neutral area so floating menus close and validation re-runs.
  try {
    await page.locator("body").click({ position: { x: 8, y: 8 }, timeout: 800 }).catch(() => {});
    if (did) await humanPause(200, 400);
  } catch {
    /* ignore */
  }

  return did;
}
