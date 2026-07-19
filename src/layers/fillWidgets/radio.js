/**
 * Radio / application-radio custom control fillers.
 */
import { humanPause } from "../../human.js";
import { EEOC_DECLINE_OPTION_RE } from "../../primitives/controlPatterns.js";
import { scopedDialog, visible } from "./shared.js";
import { clickYesNoInContainer } from "./yesNo.js";

export async function fillRadioGroup(page, labelRe, value, log, snap = null) {
  if (!value) return false;
  const scope = scopedDialog(page, snap, "fill_parent");
  const root = (await scope.count().catch(() => 0)) > 0 ? scope : page;
  try {
    const radios = root.locator("[role='radiogroup'] [role='radio'], input[type='radio']");
    const count = await radios.count();
    for (let i = 0; i < count; i += 1) {
      const r = radios.nth(i);
      const blob = `${await r.getAttribute("aria-label").catch(() => "")} ${await r.innerText().catch(() => "")}`;
      if (!labelRe.test(blob) && !new RegExp(value, "i").test(blob)) continue;
      await r.click({ timeout: 3000 });
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

export async function fillApplicationRadio(page, spec, value, log, snap = null) {
  if (!value) return false;
  const scope = scopedDialog(page, snap, "fill_parent");
  const root = (await scope.count().catch(() => 0)) > 0 ? scope : page;
  const labelSnippet = (spec.questionLabel || spec.label || "")
    .slice(0, 72)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declineRe = EEOC_DECLINE_OPTION_RE;
  const raw = String(value).trim();
  const yesNo = /^(yes|y|true|1)$/i.test(raw) ? "Yes" : /^(no|n|false|0)$/i.test(raw) ? "No" : null;
  const answerRe = declineRe.test(raw)
    ? declineRe
    : yesNo
      ? new RegExp(`^\\s*${yesNo}\\s*$`, "i")
      : new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

  try {
    let field = spec.selector ? root.locator(spec.selector).first() : null;
    if (!field || !(await visible(field))) {
      field = root
        .locator(
          'fieldset, [class*="ashby-application-form-field-entry"], .application-question, .custom-question, [data-qa="multiple-choice"], .field, [role="radiogroup"]',
        )
        .filter({ hasText: new RegExp(labelSnippet, "i") })
        .first();
    }
    if (!(await visible(field))) return false;

    if (yesNo && (await clickYesNoInContainer(field, yesNo))) {
      await humanPause(200, 350);
      return true;
    }

    const labelOpt = field.locator("label").filter({ hasText: answerRe }).first();
    if (await visible(labelOpt)) {
      await labelOpt.click({ timeout: 4000 });
      await humanPause(200, 350);
      return true;
    }
    const textOpt = field.getByText(answerRe).first();
    if (await visible(textOpt)) {
      await textOpt.click({ timeout: 4000 });
      await humanPause(200, 350);
      return true;
    }
    // Soft match for long remote-preference option text.
    if (!yesNo && raw.length > 8) {
      const soft = field.getByText(new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 28), "i")).first();
      if (await visible(soft)) {
        await soft.click({ timeout: 4000 });
        await humanPause(200, 350);
        return true;
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}
