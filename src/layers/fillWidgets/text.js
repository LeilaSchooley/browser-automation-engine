/**
 * Text and contenteditable custom control fillers.
 */
import { humanType } from "../../human.js";
import { scopedDialog, visible } from "./shared.js";

export async function fillTextControl(page, specOrLabelRe, value, log, snap = null) {
  if (!value) return false;
  const spec =
    specOrLabelRe && typeof specOrLabelRe === "object" && !(specOrLabelRe instanceof RegExp)
      ? specOrLabelRe
      : { labelRe: specOrLabelRe };
  const labelRe = spec.labelRe instanceof RegExp ? spec.labelRe : null;

  try {
    if (spec.selector || spec.triggerSelector) {
      const loc = page.locator(spec.selector || spec.triggerSelector).first();
      if (await visible(loc)) {
        const cur = await loc.inputValue().catch(() => "");
        if (!String(cur || "").trim()) {
          await loc.fill(String(value), { timeout: 5000 });
          log?.layer("custom_controls", `filled text via selector`, "debug");
          return true;
        }
        return true;
      }
    }
  } catch {
    /* fall through */
  }

  if (labelRe) {
    try {
      const byLabel = page.getByLabel(labelRe, { exact: false });
      if ((await byLabel.count()) > 0 && (await visible(byLabel.first()))) {
        const cur = await byLabel.first().inputValue().catch(() => "");
        if (!cur.trim()) {
          await byLabel.first().fill(value, { timeout: 5000 });
          log?.layer("custom_controls", `filled ${labelRe} via label`, "debug");
          return true;
        }
      }
    } catch {
      /* next */
    }
    try {
      const scope = page.locator("[role='dialog'], [aria-modal='true']").first();
      const root = (await scope.count()) > 0 ? scope : page;
      const inputs = root.locator("input[type='text'], input:not([type]), textarea");
      const count = await inputs.count();
      for (let i = 0; i < count; i += 1) {
        const input = inputs.nth(i);
        const blob = `${await input.getAttribute("placeholder").catch(() => "")} ${await input.getAttribute("aria-label").catch(() => "")}`.toLowerCase();
        if (labelRe.test(blob)) {
          const cur = await input.inputValue().catch(() => "");
          if (!cur.trim()) {
            await input.fill(value, { timeout: 5000 });
            log?.layer("custom_controls", `filled ${labelRe} via placeholder`, "debug");
            return true;
          }
        }
      }
    } catch {
      /* ignore */
    }
  }
  return false;
}

export async function fillContentEditable(page, labelRe, value, log) {
  if (!value) return false;
  try {
    const scope = page.locator("[role='dialog'], [aria-modal='true']").first();
    const root = (await scope.count()) > 0 ? scope : page;
    const editables = root.locator("[contenteditable='true']");
    const count = await editables.count();
    for (let i = 0; i < count; i += 1) {
      const el = editables.nth(i);
      const aria = (await el.getAttribute("aria-label").catch(() => "")) || "";
      const near = (await el.evaluate((node) => {
        const lbl = node.closest("label");
        return lbl ? lbl.textContent : "";
      }).catch(() => "")) || "";
      const blob = `${aria} ${near}`.toLowerCase();
      if (!labelRe.test(blob)) continue;
      if (!(await visible(el))) continue;
      await el.click({ timeout: 3000 });
      await humanType(el, value, page);
      log?.layer("custom_controls", `filled contenteditable ${labelRe}`, "debug");
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}
