/**
 * Yes/No custom control fillers.
 */
import { humanPause } from "../../human.js";
import { BEHAVIORAL_BUTTON_SEL } from "../../primitives/controlPatterns.js";
import { scopedDialog, visible } from "./shared.js";

export async function clickYesNoInContainer(container, answer) {
  const exact = new RegExp(`^\\s*${answer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
  const btn = container.locator(BEHAVIORAL_BUTTON_SEL).filter({ hasText: exact }).first();
  if (await visible(btn)) {
    await btn.click({ timeout: 4000 });
    return true;
  }
  // Lever / Greenhouse: label wrapping radio, or input[value=Yes|No].
  const labelOpt = container.locator("label").filter({ hasText: exact }).first();
  if (await visible(labelOpt)) {
    await labelOpt.click({ timeout: 4000 });
    return true;
  }
  const radioExact = container
    .locator(
      `input[type="radio"][value="${answer}"], input[type="radio"][value="${answer.toLowerCase()}"]`,
    )
    .first();
  if (await visible(radioExact)) {
    await radioExact.click({ timeout: 4000 }).catch(async () => {
      await radioExact.check({ force: true }).catch(() => {});
    });
    return true;
  }
  const spanOpt = container.locator("span, div").filter({ hasText: exact }).first();
  if (await visible(spanOpt)) {
    await spanOpt.click({ timeout: 4000 });
    return true;
  }
  return false;
}

export async function fillYesNoControl(page, spec, value, log, snap = null) {
  if (!value) return false;
  const raw = String(value).trim();
  const answer = /^(yes|y|true|1)$/i.test(raw) ? "Yes" : /^(no|n|false|0)$/i.test(raw) ? "No" : raw;
  const scope = scopedDialog(page, snap, "fill_parent");
  const root = (await scope.count().catch(() => 0)) > 0 ? scope : page;

  try {
    let container = spec.selector ? root.locator(spec.selector).first() : null;
    if (!container || !(await visible(container))) {
      const labelSnippet = (spec.questionLabel || spec.label || "")
        .slice(0, 72)
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!labelSnippet) return false;
      const entry = root
        .locator(
          '[class*="ashby-application-form-field-entry"], fieldset, [data-field-id], .application-question, .custom-question, .field, [class*="field" i], [role="radiogroup"], form div.mb-4, form > div > div',
        )
        .filter({ hasText: new RegExp(labelSnippet, "i") })
        .first();
      container = entry.locator('[class*="yesno" i], [data-qa="multiple-choice"], [role="radiogroup"]').first();
      if (!(await visible(container))) container = entry;
    }
    if (!(await visible(container))) return false;
    if (await clickYesNoInContainer(container, answer)) {
      await humanPause(200, 350);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
