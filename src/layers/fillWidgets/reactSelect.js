/**
 * React-select / ARIA combobox helpers (single + multi).
 */
import { humanPause } from "../../human.js";
import { visible } from "./shared.js";

async function openReactSelect(page, field) {
  const trigger = field
    .locator(
      "[class*='select__control'], [class*='Select__control'], [role='combobox'], [aria-haspopup='listbox']",
    )
    .first();
  if (!(await visible(trigger))) return false;
  try {
    await trigger.click({ timeout: 3000, force: true });
    await humanPause(250, 450);
    return true;
  } catch {
    return false;
  }
}

function optionLocators(page) {
  return [
    page.locator("[role='listbox'] [role='option'], [role='option']"),
    page.locator("[class*='select__option'], [class*='menu'] [class*='option'], [class*='dropdown'] li"),
  ];
}

async function clickMatchingOption(page, raw, log) {
  const wantLower = String(raw).toLowerCase().trim();
  const prefix = wantLower.slice(0, 18);
  for (const loc of optionLocators(page)) {
    const count = await loc.count().catch(() => 0);
    if (!count) continue;
    for (let i = 0; i < Math.min(count, 40); i += 1) {
      const item = loc.nth(i);
      if (!(await visible(item))) continue;
      const text = (await item.innerText().catch(() => "")).replace(/\s+/g, " ").trim().toLowerCase();
      if (!text) continue;
      const hit =
        text === wantLower ||
        (prefix.length >= 3 && text.startsWith(prefix)) ||
        (wantLower.length >= 3 && text.includes(wantLower));
      if (hit) {
        await item.click({ timeout: 4000, force: true }).catch(() => {});
        await humanPause(200, 350);
        log?.layer?.("custom_controls", `react-select picked "${text.slice(0, 40)}"`, "debug");
        return true;
      }
    }
  }
  return false;
}

/** Open a react-select inside `field` and click one option matching `raw`. */
export async function fillReactSelectInScope(page, field, raw, yesNo, log) {
  const want = yesNo || raw;
  if (!want) return false;
  if (!(await openReactSelect(page, field))) return false;
  return clickMatchingOption(page, want, log);
}

/**
 * Pick up to `maxCount` options in a react-select multi control.
 * Types into the search input when present (WaaS /application/skills).
 * @param {import('playwright').Page} page
 * @param {import('@playwright/test').Locator} field
 * @param {string[]} values
 */
export async function fillReactSelectMulti(page, field, values, log, maxCount = 4) {
  const picks = (values || []).map((v) => String(v || "").trim()).filter(Boolean).slice(0, maxCount);
  if (!picks.length) return false;
  let picked = 0;
  for (const raw of picks) {
    if (!(await openReactSelect(page, field))) break;
    const input = field
      .locator("input[id^='react-select-'][id$='-input'], input[type='text'], [role='combobox'] input")
      .first();
    if ((await input.count().catch(() => 0)) > 0 && (await visible(input))) {
      try {
        await input.fill("");
        await input.type(String(raw).slice(0, 40), { delay: 25 });
        await humanPause(350, 550);
      } catch {
        /* fall through to click match */
      }
    }
    if (await clickMatchingOption(page, raw, log)) {
      picked += 1;
      log?.layer?.("custom_controls", `react-select multi picked "${String(raw).slice(0, 40)}"`, "info");
    }
  }
  return picked > 0;
}
