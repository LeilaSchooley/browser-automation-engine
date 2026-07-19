/**
 * Combobox / listbox custom control fillers.
 */
import { pickClosestSalaryOption } from "../../salaryExpectation.js";
import { humanPause } from "../../human.js";
import { resolvePopoverScope } from "../dialogScope.js";
import { extractSalaryDisplay } from "../../primitives/controlPatterns.js";
import {
  readComboboxElementValue,
  findSalaryPickerDialog,
  readSalaryFromPage,
  readJobLeadsSalaryField,
  isSalaryPickerOpen,
  JOBLEADS_SELECTORS,
  SALARY_BAND_VISIBLE_RE,
} from "../../primitives/comboboxWidget.js";
import { readControlValue } from "../../primitives/interactWidget.js";
import {
  visible,
  commitPendingSelection,
  confirmPickerSelection,
  verifyControlCommitted,
  resolveValueForControl,
} from "./shared.js";

export async function collectListOptions(page, snap = null) {
  const dialog = resolvePopoverScope(page, snap);
  const scopes = [];
  const jlOverlay = page.locator(JOBLEADS_SELECTORS.salaryOverlay).filter({ has: page.getByText(/^salary$/i) });
  if ((await jlOverlay.count().catch(() => 0)) > 0) scopes.push({ scope: jlOverlay.last(), salaryBands: true });
  const salaryPicker = findSalaryPickerDialog(page);
  if ((await salaryPicker.count().catch(() => 0)) > 0) scopes.push({ scope: salaryPicker, salaryBands: true });
  if ((await dialog.count().catch(() => 0)) > 0) scopes.push({ scope: dialog, salaryBands: false });
  scopes.push({ scope: page, salaryBands: false });

  const locators = (scope, salaryBands = false) => {
    const list = [
      scope.locator("[role='listbox'] [role='option']"),
      scope.locator("[role='option']"),
    ];
    if (salaryBands) {
      list.push(
        scope.locator("[role='dialog'] *").filter({ hasText: SALARY_BAND_VISIBLE_RE }),
        scope.getByText(SALARY_BAND_VISIBLE_RE),
      );
    }
    list.push(
      scope.locator("[class*='dropdown'] li, [class*='menu'] li, [class*='option']"),
      scope.locator("[class*='select-menu'] li, [class*='select-menu'] button, [class*='select-menu'] div"),
    );
    return list;
  };

  for (const { scope, salaryBands } of scopes) {
    for (const loc of locators(scope, salaryBands)) {
      const count = await loc.count().catch(() => 0);
      if (!count) continue;
      const opts = [];
      for (let i = 0; i < Math.min(count, 32); i += 1) {
        const item = loc.nth(i);
        if (!(await visible(item))) continue;
        const text = (await item.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        if (!text) continue;
        opts.push({ text, index: i, locator: loc });
      }
      if (opts.length) return opts;
    }
  }
  return [];
}

export async function openComboboxTrigger(page, labelRe, triggerSelector) {
  if (triggerSelector) {
    try {
      const el = page.locator(triggerSelector).first();
      if ((await el.count()) > 0 && (await visible(el))) {
        await el.click({ timeout: 4000, force: true });
        await humanPause(350, 600);
        return true;
      }
    } catch {
      /* fall through */
    }
  }

  // React Select: click control, then focus the inner input if present.
  try {
    const rsControl = page
      .locator(".Select__control, [class*='select__control' i], [class*='Select__control']")
      .filter({ hasText: labelRe })
      .first();
    if ((await rsControl.count()) > 0 && (await visible(rsControl))) {
      await rsControl.click({ timeout: 4000, force: true });
      const rsInput = page.locator("input[id^='react-select-'][id$='-input'], .Select__input input, [class*='select__input'] input").first();
      if ((await rsInput.count()) > 0 && (await visible(rsInput))) {
        await rsInput.click({ timeout: 2000 }).catch(() => {});
      }
      await humanPause(350, 600);
      return true;
    }
  } catch {
    /* fall through */
  }

  const jlSalary = page.locator(JOBLEADS_SELECTORS.salaryField);
  if ((await jlSalary.count().catch(() => 0)) > 0 && (await visible(jlSalary.first()))) {
    await jlSalary.first().click({ timeout: 4000, force: true });
    await humanPause(350, 600);
    return true;
  }

  const prefsModal = page
    .locator("[role='dialog'], [aria-modal='true']")
    .filter({ hasText: /tell us about yourself|salary expectations/i });
  const candidates = [
    page.getByLabel(/salary expectations|compensation|pay expect/i),
    page.getByText(/^salary expectations$/i),
    prefsModal.locator("[role='combobox'], [aria-haspopup='listbox'], div, button, span").filter({ hasText: /^\?$/ }),
    page.getByRole("combobox", { name: /salary expectations|compensation|pay expect/i }),
    page.locator("[role='combobox']").filter({ hasText: /salary expectations/i }),
    page.locator("[aria-haspopup='listbox']").filter({ hasText: /salary expectations/i }),
    page.getByRole("combobox", { name: labelRe }),
    page.locator("[role='combobox']").filter({ hasText: labelRe }),
    page.locator("[aria-haspopup='listbox']").filter({ hasText: labelRe }),
    page.getByText(labelRe),
    page.locator("button, div, span").filter({ hasText: labelRe }),
    page.locator("[class*='select'], [class*='dropdown']").filter({ hasText: labelRe }),
  ];
  for (const loc of candidates) {
    try {
      const el = loc.first();
      if (!(await visible(el))) continue;
      await el.click({ timeout: 4000, force: true });
      await humanPause(350, 600);
      return true;
    } catch {
      /* next */
    }
  }
  return false;
}

export async function selectFromOptions(page, options, value, mappedTo, log) {
  if (!options.length || !value) return false;
  let chosen = null;
  if (mappedTo === "salary") {
    const pick = pickClosestSalaryOption(
      options.map((o) => ({ text: o.text, value: String(o.index) })),
      value,
    );
    chosen = pick ? options[Number(pick.value)] : null;
    if (!chosen) {
      chosen =
        options.find((o) => /negotiable|flexible|prefer not|open/i.test(o.text)) ||
        options.find((o) => o.index > 0) ||
        options[0];
    }
  } else {
    const lower = value.toLowerCase();
    chosen =
      options.find((o) => o.text.toLowerCase() === lower) ||
      (lower.length >= 3 ? options.find((o) => o.text.toLowerCase().includes(lower)) : null) ||
      options[0];
  }
  if (!chosen) return false;
  await chosen.locator.nth(chosen.index).click({ timeout: 4000, force: true });
  await humanPause(200, 350);
  log?.layer("custom_controls", `selected "${chosen.text}" for ${mappedTo}`, "info");
  return true;
}


export async function fillComboboxControl(page, { label, mappedTo, value, triggerSelector, confirmPattern, requiresConfirm }, log, snap = null) {
  if (!value && mappedTo !== "salary" && mappedTo !== "custom") return false;

  if (mappedTo === "salary" || mappedTo === "custom") {
    const jlLive = await readJobLeadsSalaryField(page);
    if (jlLive) {
      log?.layer("custom_controls", `jobleads salary already set: ${jlLive.slice(0, 40)}`, "info");
      return true;
    }
    if (!triggerSelector) triggerSelector = JOBLEADS_SELECTORS.salaryField;
  }

  const labelRe = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const needsConfirm = requiresConfirm !== false && (mappedTo === "salary" || requiresConfirm === true);
  const fillValue = value || (mappedTo === "salary" ? "" : "");

  if (await openComboboxTrigger(page, labelRe, triggerSelector)) {
    const options = await collectListOptions(page, snap);
    if (options.length && (await selectFromOptions(page, options, fillValue || value, mappedTo, log))) {
      if (needsConfirm) {
        const verifyOpts = { selector: triggerSelector, log };
        await humanPause(320, 520);
        if (await verifyControlCommitted(page, mappedTo === "custom" ? "salary" : mappedTo, log, verifyOpts)) {
          return true;
        }
        await commitPendingSelection(page, log, { confirmPattern, snap });
        await humanPause(500, 800);
        const verifyMapped = mappedTo === "custom" ? "salary" : mappedTo;
        if (await verifyControlCommitted(page, verifyMapped, log, verifyOpts)) {
          return true;
        }
        const liveSalary =
          mappedTo === "salary" || mappedTo === "custom" ? await readSalaryFromPage(page) : "";
        if (liveSalary && (await isSalaryPickerOpen(page)) === false) {
          log?.layer("custom_controls", `${mappedTo} committed (modal read): ${liveSalary.slice(0, 40)}`, "info");
          return true;
        }
        const prefsText = await page
          .locator("[role='dialog'], [aria-modal='true']")
          .filter({ hasText: /tell us about yourself/i })
          .last()
          .innerText({ timeout: 2000 })
          .catch(() => "");
        if (
          prefsText &&
          /salary expectations/i.test(prefsText) &&
          !/salary expectations[^\n$€£]*\?/i.test(prefsText.replace(/\s+/g, " "))
        ) {
          const fromPrefs = extractSalaryDisplay(prefsText);
          if (fromPrefs) {
            log?.layer("custom_controls", `${mappedTo} committed (prefs text): ${fromPrefs.slice(0, 40)}`, "info");
            return true;
          }
        }
        if (mappedTo !== "salary" && mappedTo !== "custom") return true;
        log?.layer("custom_controls", `${mappedTo} not committed after confirm`, "warn");
        return false;
      }
      return true;
    }
    const combo = page.locator("[role='combobox'], input").filter({ hasText: labelRe }).first();
    if (await visible(combo) && value) {
      await combo.fill(value, { timeout: 3000 }).catch(() => {});
      await page.keyboard.press("Enter").catch(() => {});
      if (needsConfirm) {
        await confirmPickerSelection(page, log, { confirmPattern, snap });
        return verifyControlCommitted(page, mappedTo, log);
      }
      return true;
    }
  }
  if (mappedTo === "salary" && value) {
    const band = page.getByText(/\$[\d,]+|€[\d,]+|£[\d,]+|USD|negotiable|flexible/i).first();
    if (await visible(band)) {
      await band.click({ timeout: 3000 }).catch(() => {});
      if (needsConfirm) {
        await confirmPickerSelection(page, log, { confirmPattern, snap });
        return verifyControlCommitted(page, mappedTo, log);
      }
      return true;
    }
  }
  return false;
}


/** Fill combobox by label — reusable entry for salary, location pickers, etc. */
export async function fillComboboxByLabel(page, spec, context, opts = {}) {
  const mappedTo = spec.mappedTo || "custom";
  const label = spec.label || mappedTo;
  const value = spec.value ?? resolveValueForControl(mappedTo, label, context);
  const triggerSelector = spec.triggerSelector || spec.selector || "";
  const snap = opts.snap || null;
  const log = opts.log || null;

  if (triggerSelector) {
    const live = await readComboboxElementValue(page.locator(triggerSelector), mappedTo);
    if (live) {
      log?.layer("custom_controls", `${mappedTo} already committed: ${live.slice(0, 40)}`, "info");
      return { ok: true, value: live };
    }
  }

  const ok = await fillComboboxControl(
    page,
    {
      label,
      mappedTo,
      value,
      triggerSelector,
      confirmPattern: spec.confirmPattern,
      requiresConfirm: spec.requiresConfirm ?? mappedTo === "salary",
    },
    log,
    snap,
  );

  if (!ok) return { ok: false, value: "" };
  const finalValue = await readControlValue(page, mappedTo, { selector: triggerSelector });
  return { ok: Boolean(finalValue), value: finalValue };
}
