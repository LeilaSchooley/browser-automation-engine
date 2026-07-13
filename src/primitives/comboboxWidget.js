/**
 * Generic combobox read helpers — MUI, React Select, Headless UI, native listbox.
 */
import { extractSalaryDisplay, isCommittedValue, BEHAVIORAL_BUTTON_SEL } from "./controlPatterns.js";

/** Visible salary band text in pickers and committed fields. */
export const SALARY_BAND_VISIBLE_RE =
  /(?:(?:USD|EUR|GBP|€|£|\$)\s*[\d,]+|\$[\d,]+)(?:\s*[-–—]\s*(?:(?:USD|EUR|GBP|€|£|\$)\s*[\d,]+|\$[\d,]+|\d[\d,]+))?/i;

/** Normalize a raw combobox blob into a committed display value. */
export function normalizeComboboxDisplay(blob, mappedTo = "") {
  const m = String(mappedTo || "").toLowerCase();
  const trimmed = String(blob || "").replace(/\s+/g, " ").trim();
  if (!trimmed) return "";
  if (m === "salary") return extractSalaryDisplay(trimmed);
  return isCommittedValue(trimmed, m) ? trimmed : "";
}

/**
 * Read committed value from a combobox locator using multiple strategies.
 * @param {import('playwright').Page} page
 * @param {import('playwright').Locator} loc
 * @param {string} [mappedTo]
 */
export async function readComboboxElementValue(loc, mappedTo = "") {
  try {
    if ((await loc.count().catch(() => 0)) === 0) return "";
    const el = loc.first();
    const ariaValueText = (await el.getAttribute("aria-valuetext").catch(() => "")) || "";
    const innerText = (await el.innerText().catch(() => "")) || "";
    const ariaLabel = (await el.getAttribute("aria-label").catch(() => "")) || "";
    const inputValue = (await el.inputValue().catch(() => "")) || "";
    const deepText = await el
      .evaluate((node) => {
        const pick =
          node.querySelector(
            "[class*='value' i], [class*='select' i], [class*='display' i], [data-value]",
          ) || node.querySelector("span:not(:empty)");
        const fromChild = pick?.textContent?.trim() || "";
        const dataVal = node.getAttribute("data-value") || pick?.getAttribute("data-value") || "";
        return [fromChild, dataVal].filter(Boolean).join(" ").trim();
      })
      .catch(() => "");

    for (const raw of [ariaValueText, innerText, deepText, inputValue, ariaLabel]) {
      const normalized = normalizeComboboxDisplay(raw, mappedTo);
      if (normalized && isCommittedValue(normalized, mappedTo || "salary")) return normalized;
    }

    const combined = normalizeComboboxDisplay(
      [ariaValueText, innerText, deepText, inputValue, ariaLabel].filter(Boolean).join(" "),
      mappedTo,
    );
    return combined && isCommittedValue(combined, mappedTo || "salary") ? combined : "";
  } catch {
    return "";
  }
}

export const JOBLEADS_SELECTORS = {
  salaryField: '[data-testid="registration-form-extra-salary-field"]',
  salaryInput: '[data-testid="registration-form-extra-salary-field"] input.select-menu-dropdown__input',
  salaryOverlay: ".ui-slide-overlay",
  prefsModal: '[data-testid="modal-RegistrationModalSignUp"]',
  submitButton: '[data-testid="registration-form-extra-submit-button"]',
  locationInput: '[data-testid="registration-form-extra-location-field-ui-autocomplete-input"]',
  titleInput: '[data-testid="registration-form-extra-desired-job-title-field-ui-typeahead-input"]',
};

/** Read committed salary from JobLeads select-menu-dropdown input. */
export async function readJobLeadsSalaryField(page) {
  try {
    const input = page.locator(JOBLEADS_SELECTORS.salaryInput);
    if ((await input.count().catch(() => 0)) === 0) return "";
    const value = `${await input.inputValue().catch(() => "")} ${await input.getAttribute("value").catch(() => "")}`;
    return extractSalaryDisplay(value);
  } catch {
    return "";
  }
}

/**
 * Locate the topmost salary picker overlay (JobLeads-style custom dialog).
 * @param {import('playwright').Page} page
 */
export function findSalaryPickerDialog(page) {
  const slideOverlay = page
    .locator(JOBLEADS_SELECTORS.salaryOverlay)
    .filter({ has: page.getByText(/^salary$/i) });
  const modalShell =
    "[role='dialog'], [aria-modal='true'], [class*='Modal' i], [class*='modal' i], [class*='picker' i], [class*='overlay' i], [class*='drawer' i], [class*='popup' i]";
  const byTitle = page
    .locator(modalShell)
    .filter({ has: page.getByRole("heading", { name: /^salary$/i }) });
  const byLabel = page.locator(modalShell).filter({ has: page.getByText(/^salary$/i) });
  const byBands = page
    .locator(modalShell)
    .filter({ has: page.locator(BEHAVIORAL_BUTTON_SEL).filter({ hasText: /^save$/i }) })
    .filter({ has: page.getByText(SALARY_BAND_VISIBLE_RE) });
  const byHeadingSave = page
    .getByRole("heading", { name: /^salary$/i })
    .locator(
      "xpath=ancestor::*[contains(@class,'modal') or contains(@class,'Modal') or contains(@class,'picker') or contains(@class,'overlay') or contains(@class,'popup') or @role='dialog' or @aria-modal='true'][1]",
    );
  return slideOverlay.or(byTitle).or(byLabel).or(byBands).or(byHeadingSave).last();
}

/** Topmost visible dialog that exposes a Save confirm for an open picker. */
export function findPickerConfirmDialog(page) {
  return page
    .locator("[role='dialog'], [aria-modal='true'], [class*='Modal' i], [class*='modal' i]")
    .filter({ has: page.getByRole("button", { name: /^save$/i }) })
    .last();
}

/** @param {import('playwright').Page} page */
export async function isSalaryPickerOpen(page) {
  const overlay = page.locator(JOBLEADS_SELECTORS.salaryOverlay).filter({ has: page.getByText(/^salary$/i) });
  if ((await overlay.count().catch(() => 0)) > 0) {
    return overlay.last().isVisible({ timeout: 400 }).catch(() => false);
  }
  const picker = findSalaryPickerDialog(page);
  if ((await picker.count().catch(() => 0)) > 0) {
    return picker.first().isVisible({ timeout: 400 }).catch(() => false);
  }
  const listbox = page.locator("[role='listbox']").first();
  if ((await listbox.count().catch(() => 0)) === 0) return false;
  return listbox.isVisible({ timeout: 400 }).catch(() => false);
}

/**
 * Collect locators that represent the salary expectations combobox trigger (not picker options).
 * @param {import('playwright').Page} page
 */
async function collectSalaryComboboxLocators(page) {
  const locators = [
    page.getByRole("combobox", { name: /salary expectations|compensation|pay expect/i }),
    page.getByLabel(/salary expectations|compensation|pay expect/i),
    page.locator("[role='combobox']").filter({ hasText: /salary expectations/i }),
  ];

  const labels = page.locator("label").filter({ hasText: /salary expectations|compensation|pay expect/i });
  const labelCount = await labels.count().catch(() => 0);
  for (let i = 0; i < labelCount; i += 1) {
    const label = labels.nth(i);
    const forId = (await label.getAttribute("for").catch(() => "")) || "";
    if (forId) locators.push(page.locator(`#${CSS.escape(forId)}`));
    locators.push(label.locator("xpath=following::*[@role='combobox' or @aria-haspopup='listbox'][1]"));
  }

  const combos = page.locator("[role='combobox'], [aria-haspopup='listbox']");
  const count = await combos.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const combo = combos.nth(i);
    if (!(await combo.isVisible({ timeout: 300 }).catch(() => false))) continue;
    const inPicker = await combo
      .evaluate((node) => !!node.closest("[role='listbox'], [role='dialog'][aria-label*='Salary' i]"))
      .catch(() => false);
    if (inPicker) continue;
    const blob = `${await combo.innerText().catch(() => "")} ${await combo.getAttribute("aria-label").catch(() => "")}`;
    if (/salary|compensation|pay expect/i.test(blob)) {
      locators.push(combo);
      continue;
    }
    const nearLabel = await combo
      .evaluate((node) => {
        const label = node.closest("label")?.textContent?.trim() || "";
        const prev = node.previousElementSibling?.textContent?.trim() || "";
        const parent = node.parentElement?.textContent?.slice(0, 80) || "";
        return `${label} ${prev} ${parent}`;
      })
      .catch(() => "");
    if (/salary expectations|compensation|pay expect/i.test(nearLabel)) locators.push(combo);
  }

  return locators;
}

/** Read salary from MUI floating-label block inside the preferences modal. */
async function readSalaryFromPreferencesModal(page) {
  if (await isSalaryPickerOpen(page)) return "";

  const modal = page
    .locator("[role='dialog'], [aria-modal='true']")
    .filter({ hasText: /tell us about yourself|salary expectations|desired job title/i })
    .last();
  if ((await modal.count().catch(() => 0)) === 0) return "";

  const bands = modal.getByText(SALARY_BAND_VISIBLE_RE);
  const bandCount = await bands.count().catch(() => 0);
  for (let i = 0; i < bandCount; i += 1) {
    const band = bands.nth(i);
    if (!(await band.isVisible({ timeout: 400 }).catch(() => false))) continue;
    const inPickerRow = await band
      .evaluate((el) => !!el.closest("[role='listbox'], [role='option'], [role='menu'], [class*='option' i]"))
      .catch(() => true);
    if (inPickerRow) continue;
    const val = extractSalaryDisplay((await band.innerText().catch(() => "")).trim());
    if (val) return val;
  }

  const salaryLabel = modal.getByText(/^salary expectations$/i).first();
  if ((await salaryLabel.count().catch(() => 0)) > 0) {
    const block = salaryLabel.locator("xpath=ancestor::*[self::div or self::label][position()<=5][1]");
    const text = (await block.innerText({ timeout: 1500 }).catch(() => "")).replace(/\s+/g, " ");
    const val = extractSalaryDisplay(text.replace(/salary expectations/i, ""));
    if (val) return val;
  }

  const modalText = (await modal.innerText({ timeout: 2000 }).catch(() => "")).replace(/\s+/g, " ");
  if (/salary expectations/i.test(modalText) && !/salary expectations[^A-Z$€£]*\?/i.test(modalText)) {
    const afterLabel = modalText.match(
      /salary expectations\s*(USD\s*[\d,]+(?:\s*[-–—]\s*[\d,]+)?|\$[\d,]+(?:\s*[-–—]\s*\$?[\d,]+)?)/i,
    );
    if (afterLabel?.[1]) {
      const val = extractSalaryDisplay(afterLabel[1]);
      if (val) return val;
    }
    const anyBand = extractSalaryDisplay(modalText);
    if (anyBand) return anyBand;
  }
  return "";
}

/**
 * Click Save inside the salary picker overlay (JobLeads uses non-dialog portals).
 * @param {import('playwright').Page} page
 * @param {{ layer?: Function }} [log]
 */
export async function clickSalaryPickerSave(page, log = null) {
  const overlay = page.locator(JOBLEADS_SELECTORS.salaryOverlay).filter({ has: page.getByText(/^salary$/i) });
  if ((await overlay.count().catch(() => 0)) > 0 && (await overlay.last().isVisible({ timeout: 500 }).catch(() => false))) {
    const saveInOverlay = overlay
      .last()
      .locator(BEHAVIORAL_BUTTON_SEL)
      .filter({ hasText: /^save$/i })
      .first();
    if ((await saveInOverlay.count().catch(() => 0)) > 0) {
      await saveInOverlay.click({ timeout: 4000, force: true });
      log?.layer?.("custom_controls", "confirmed salary picker Save (ui-slide-overlay)", "info");
      return true;
    }
  }

  const picker = findSalaryPickerDialog(page);
  if ((await picker.count().catch(() => 0)) > 0 && (await picker.first().isVisible({ timeout: 500 }).catch(() => false))) {
    const saveInPicker = picker.locator(BEHAVIORAL_BUTTON_SEL).filter({ hasText: /^save$/i }).first();
    if ((await saveInPicker.count().catch(() => 0)) > 0) {
      await saveInPicker.click({ timeout: 4000, force: true });
      log?.layer?.("custom_controls", "confirmed salary picker Save (picker scope)", "info");
      return true;
    }
  }

  const saves = page.locator(BEHAVIORAL_BUTTON_SEL).filter({ hasText: /^save$/i });
  const count = await saves.count().catch(() => 0);
  let best = null;
  let bestScore = -1;

  for (let i = 0; i < count; i += 1) {
    const btn = saves.nth(i);
    if (!(await btn.isVisible({ timeout: 300 }).catch(() => false))) continue;
    const score = await btn
      .evaluate((el) => {
        let n = el;
        let s = 0;
        for (let d = 0; d < 12 && n; d += 1) {
          const t = (n.textContent || "").slice(0, 600);
          if (/\bsalary\b/i.test(t) && !/salary expectations/i.test(t.slice(0, 40))) s += 50;
          if (/USD\s*[\d,]{2,}/i.test(t)) s += 25;
          if (/tell us about yourself/i.test(t)) s -= 35;
          n = n.parentElement;
        }
        return s;
      })
      .catch(() => 0);
    if (score > bestScore) {
      bestScore = score;
      best = btn;
    }
  }

  if (best && bestScore > 0) {
    await best.click({ timeout: 4000, force: true });
    log?.layer?.("custom_controls", `confirmed salary picker Save (scored=${bestScore})`, "info");
    return true;
  }

  const bandsOpen = await page
    .getByText(SALARY_BAND_VISIBLE_RE)
    .first()
    .isVisible({ timeout: 400 })
    .catch(() => false);
  if (bandsOpen) {
    for (let i = count - 1; i >= 0; i -= 1) {
      const btn = saves.nth(i);
      if (await btn.isVisible({ timeout: 300 }).catch(() => false)) {
        await btn.click({ timeout: 4000, force: true });
        log?.layer?.("custom_controls", "confirmed salary picker Save (topmost visible)", "info");
        return true;
      }
    }
  }
  return false;
}

/**
 * Read committed salary from the expectations combobox trigger only — never from open picker rows.
 * @param {import('playwright').Page} page
 */
export async function readSalaryFromPage(page) {
  try {
    const fromJobLeads = await readJobLeadsSalaryField(page);
    if (fromJobLeads) return fromJobLeads;

    const pickerOpen = await isSalaryPickerOpen(page);
    const candidates = await collectSalaryComboboxLocators(page);

    for (const loc of candidates) {
      try {
        if ((await loc.count().catch(() => 0)) === 0) continue;
        const el = loc.first();
        if (!(await el.isVisible({ timeout: 500 }).catch(() => false))) continue;
        const val = await readComboboxElementValue(el, "salary");
        if (val) return val;
        if (pickerOpen) return "";
      } catch {
        /* next */
      }
    }

    const fromModal = await readSalaryFromPreferencesModal(page);
    if (fromModal) return fromModal;
  } catch {
    /* ignore */
  }
  return "";
}
