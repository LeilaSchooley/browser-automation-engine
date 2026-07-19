/**
 * Shared helpers for custom control fill widgets.
 */
import { getPreferencesFromContext, resolvePreferenceFillValue } from "../../fillPreferences.js";
import { resolveIdentityFillValue } from "../../fillProfile.js";
import { resolveApplicationAnswer } from "../../fillApplicationAnswers.js";
import { humanPause } from "../../human.js";
import { loadSiteLearnings } from "../../siteLearnings.js";
import { normalizeHost } from "../../host.js";
import { resolveDialogScope } from "../dialogScope.js";
import { normalizeRoleName, safeRoleLocator } from "../../primitives/safeLocator.js";
import {
  mapLabelToMapped,
  mapApplicationLabelToMapped,
  BEHAVIORAL_BUTTON_SEL,
  PICKER_CONFIRM_PATTERNS,
} from "../../primitives/controlPatterns.js";
import { verifyCommitted } from "../../primitives/interactWidget.js";
import {
  findSalaryPickerDialog,
  findPickerConfirmDialog,
  clickSalaryPickerSave,
  SALARY_BAND_VISIBLE_RE,
} from "../../primitives/comboboxWidget.js";

export function scopedDialog(page, snap, intent = "confirm_picker") {
  return resolveDialogScope(page, snap, intent);
}

export async function resolveConfirmScope(page, snap = null) {
  try {
    const salaryPicker = findSalaryPickerDialog(page);
    if ((await salaryPicker.count().catch(() => 0)) > 0 && (await isVisible(salaryPicker))) {
      return salaryPicker;
    }

    const pickerConfirm = findPickerConfirmDialog(page);
    if ((await pickerConfirm.count().catch(() => 0)) > 0 && (await isVisible(pickerConfirm))) {
      const hasBands = (await pickerConfirm.getByText(SALARY_BAND_VISIBLE_RE).count().catch(() => 0)) > 0;
      if (hasBands) return pickerConfirm;
    }

    const dialogs = page.locator("[role='dialog'][aria-modal='true'], [role='dialog']");
    const count = await dialogs.count().catch(() => 0);
    let best = null;
    let bestZ = -1;
    for (let i = 0; i < count; i += 1) {
      const dialog = dialogs.nth(i);
      if (!(await isVisible(dialog))) continue;
      const title = (await dialog.innerText().catch(() => "")).slice(0, 80);
      const hasListbox = (await dialog.locator("[role='listbox']").count().catch(() => 0)) > 0;
      const hasSalaryBands = SALARY_BAND_VISIBLE_RE.test(title);
      const hasSave =
        (await dialog.getByRole("button", { name: /^save$/i }).count().catch(() => 0)) > 0 ||
        (await dialog.locator(BEHAVIORAL_BUTTON_SEL).filter({ hasText: /^save$/i }).count().catch(() => 0)) > 0;
      if (!hasListbox && !hasSave && !hasSalaryBands) continue;
      const z = await dialog
        .evaluate((el) => parseInt(getComputedStyle(el).zIndex, 10) || 0)
        .catch(() => 0);
      if (z >= bestZ) {
        bestZ = z;
        best = dialog;
      }
    }
    if (best) return best;
  } catch {
    /* fall through */
  }
  return scopedDialog(page, snap, "confirm_picker");
}

export async function isVisible(loc) {
  return loc.isVisible({ timeout: 900 }).catch(() => false);
}

/** @deprecated use isVisible */
export async function visible(loc) {
  return isVisible(loc);
}

export async function commitPendingSelection(page, log, { confirmPattern, snap = null, pageState = null } = {}) {
  if (await clickSalaryPickerSave(page, log)) {
    await humanPause(320, 520);
    await findSalaryPickerDialog(page).waitFor({ state: "hidden", timeout: 3000 }).catch(() => {});
    return true;
  }

  const dialog = await resolveConfirmScope(page, snap);
  const pickerScoped =
    !!snap?.pickerOpen ||
    (await dialog.locator("[role='listbox']").count().catch(() => 0)) > 0 ||
    (await findSalaryPickerDialog(page).count().catch(() => 0)) > 0 ||
    (snap?.dialogStack || []).some((d) => /salary|compensation|picker|select/i.test(d.title || ""));
  const patterns = confirmPattern
    ? [new RegExp(confirmPattern, "i")]
    : PICKER_CONFIRM_PATTERNS;

  const candidates = pageState?.confirmAffordances?.length
    ? pageState.confirmAffordances
    : (snap?.confirmCandidates || []).slice(0, 6).map((c) => ({ text: c.text, selector: c.selector }));

  for (const cand of candidates) {
    if (!cand.text && !cand.selector) continue;
    try {
      if (cand.selector) {
        const loc = dialog.locator(cand.selector).first();
        if ((await loc.count()) > 0 && (await visible(loc))) {
          await loc.click({ timeout: 4000, force: true });
          log?.layer("custom_controls", `confirmed via candidate ${cand.text || cand.selector}`, "info");
          await humanPause(250, 450);
          return true;
        }
      }
      const textRe = normalizeRoleName(String(cand.text || "").slice(0, 40));
      if (!textRe) continue;
      const btn = safeRoleLocator(dialog, "button", textRe);
      if ((await btn.count()) > 0 && (await visible(btn.first()))) {
        await btn.first().click({ timeout: 4000 });
        log?.layer("custom_controls", `confirmed via scored button ${cand.text}`, "info");
        await humanPause(250, 450);
        return true;
      }
    } catch {
      /* next */
    }
  }

  for (const pattern of patterns) {
    try {
      const inDialog = safeRoleLocator(dialog, "button", pattern);
      if ((await inDialog.count()) > 0 && (await visible(inDialog.first()))) {
        await inDialog.first().click({ timeout: 4000, force: true });
        log?.layer("custom_controls", `confirmed picker via button ${pattern}`, "info");
        await humanPause(320, 520);
        await findSalaryPickerDialog(page).waitFor({ state: "hidden", timeout: 2500 }).catch(() => {});
        return true;
      }
      const safePat = normalizeRoleName(pattern);
      const divBtn = dialog.locator(BEHAVIORAL_BUTTON_SEL).filter({ hasText: safePat || pattern });
      if ((await divBtn.count()) > 0 && (await visible(divBtn.first()))) {
        await divBtn.first().click({ timeout: 4000, force: true });
        log?.layer("custom_controls", `confirmed picker via div-button ${pattern}`, "info");
        await humanPause(320, 520);
        await findSalaryPickerDialog(page).waitFor({ state: "hidden", timeout: 2500 }).catch(() => {});
        return true;
      }
      if (!pickerScoped) {
        const stacked = findPickerConfirmDialog(page);
        const stackCount = await stacked.count().catch(() => 0);
        for (let i = stackCount - 1; i >= 0; i -= 1) {
          const layer = stacked.nth(i);
          if (!(await visible(layer))) continue;
          const saveInLayer = safeRoleLocator(layer, "button", pattern);
          if ((await saveInLayer.count()) > 0 && (await visible(saveInLayer.first()))) {
            await saveInLayer.first().click({ timeout: 4000, force: true });
            log?.layer("custom_controls", `confirmed picker via stacked dialog button ${pattern}`, "info");
            await humanPause(320, 520);
            await findSalaryPickerDialog(page).waitFor({ state: "hidden", timeout: 2500 }).catch(() => {});
            return true;
          }
        }
        const pageBtn = safeRoleLocator(page, "button", pattern);
        if ((await pageBtn.count()) > 0 && (await visible(pageBtn.first()))) {
          await pageBtn.first().click({ timeout: 4000, force: true });
          log?.layer("custom_controls", `confirmed picker via page button ${pattern}`, "info");
          await humanPause(250, 450);
          return true;
        }
      }
    } catch {
      /* next */
    }
  }
  return false;
}


export async function confirmPickerSelection(page, log, opts = {}) {
  return commitPendingSelection(page, log, opts);
}

export async function verifyControlCommitted(page, mappedTo, log, opts = {}) {
  return verifyCommitted(page, mappedTo, { ...opts, log });
}

export function mapLabelToType(label) {
  return mapLabelToMapped(label) || mapApplicationLabelToMapped(label);
}

export function resolveValueForControl(mappedTo, label, context) {
  const appAnswer = resolveApplicationAnswer(mappedTo, label, context);
  if (appAnswer) return appAnswer;

  const hint = `${label} ${mappedTo}`;
  const prefs = getPreferencesFromContext(context);
  const byMapped = {
    // City typeaheads match better on the city token than "City, country".
    location: prefs.city || prefs.location,
    desiredtitle: prefs.desiredTitle,
    salary: prefs.salary,
    country: prefs.country,
  };
  if (byMapped[mappedTo]) return String(byMapped[mappedTo] || "").trim();
  return (
    String(resolvePreferenceFillValue(hint, "", context) || "").trim() ||
    String(resolveIdentityFillValue(hint, "", context) || "").trim()
  );
}

export function learnedSkillsForContext(context) {
  const host = normalizeHost(context?.targetHost || context?.hostname || "");
  const fromContext = context?.siteLearnings?.controlSkills;
  if (Array.isArray(fromContext) && fromContext.length) return fromContext;
  if (!host) return [];
  const hosts = loadSiteLearnings();
  return hosts[host]?.controlSkills || [];
}
