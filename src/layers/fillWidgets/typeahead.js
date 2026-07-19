/**
 * Typeahead / autocomplete custom control filler.
 */
import { humanPause, humanType } from "../../human.js";
import { fillComboboxControl } from "./combobox.js";
import { scopedDialog, visible } from "./shared.js";

function queryToken(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  // Prefer city token before country/code for Places-style suggestions.
  return raw.split(",")[0].trim() || raw;
}

async function resolveTypeaheadInput(root, page, labelRe, selector) {
  if (selector) {
    const host = page.locator(selector).first();
    if ((await host.count().catch(() => 0)) > 0 && (await visible(host))) {
      const nested = host.locator("input").first();
      if ((await nested.count().catch(() => 0)) > 0 && (await visible(nested))) return nested;
      const tag = await host.evaluate((el) => el.tagName?.toLowerCase() || "").catch(() => "");
      if (tag === "input") return host;
    }
  }

  const candidates = [
    root.getByRole("combobox", { name: labelRe }),
    root.getByLabel(labelRe),
    root.locator("[role='combobox']").filter({ hasText: labelRe }),
    root.locator("input[role='combobox'], [role='combobox'] input, input[aria-autocomplete]"),
  ];
  for (const loc of candidates) {
    try {
      const el = loc.first();
      if ((await el.count().catch(() => 0)) === 0) continue;
      if (!(await visible(el))) continue;
      const tag = await el.evaluate((node) => node.tagName?.toLowerCase() || "").catch(() => "");
      if (tag === "input" || tag === "textarea") return el;
      const nested = el.locator("input, textarea").first();
      if ((await nested.count().catch(() => 0)) > 0 && (await visible(nested))) return nested;
      // Div/role=combobox without an input is a static picker — let combobox fill handle it.
    } catch {
      /* next */
    }
  }
  return null;
}

async function pickSuggestion(page, value) {
  const token = queryToken(value);
  if (!token) return false;
  const escaped = token.slice(0, 24).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tokenRe = new RegExp(escaped, "i");
  const options = page.locator("[role='option'], [role='listbox'] li, .pac-item");
  const count = await options.count().catch(() => 0);
  for (let i = 0; i < Math.min(count, 16); i += 1) {
    const opt = options.nth(i);
    if (!(await visible(opt))) continue;
    const text = (await opt.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (text && tokenRe.test(text)) {
      await opt.click({ timeout: 3000 });
      return true;
    }
  }
  const fallback = options.first();
  if ((await fallback.count().catch(() => 0)) > 0 && (await visible(fallback))) {
    await fallback.click({ timeout: 3000 }).catch(() => {});
    return true;
  }
  await page.keyboard.press("Enter").catch(() => {});
  return true;
}

/**
 * @param {import('playwright').Page} page
 * @param {RegExp|string} labelRe
 * @param {string} value
 * @param {{ layer?: Function }|null} log
 * @param {object|null} snap
 * @param {{ selector?: string, triggerSelector?: string }} [spec]
 */
export async function fillTypeaheadControl(page, labelRe, value, log, snap = null, spec = {}) {
  if (!value) return false;
  const token = queryToken(value);
  if (!token) return false;

  const scope = scopedDialog(page, snap, "fill_parent");
  const root = (await scope.count().catch(() => 0)) > 0 ? scope : page;
  const re =
    labelRe instanceof RegExp
      ? labelRe
      : new RegExp(String(labelRe || "city|location|live in").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

  try {
    const input = await resolveTypeaheadInput(
      root,
      page,
      re,
      spec.triggerSelector || spec.selector || "",
    );
    if (!input) {
      // Portaled / static listbox comboboxes have no nested input — use combobox pick path.
      return fillComboboxControl(
        page,
        {
          label: String(labelRe?.source || labelRe || "location"),
          mappedTo: spec.mappedTo || "location",
          value: token,
          triggerSelector: spec.triggerSelector || spec.selector,
          requiresConfirm: false,
        },
        log,
        snap,
      );
    }

    await input.click({ timeout: 3000 });
    await input.fill("").catch(() => {});
    await humanType(input, token, page);
    await humanPause(450, 750);
    const ok = await pickSuggestion(page, token);
    if (ok) {
      log?.layer?.("custom_controls", `typeahead selected for "${token}"`, "info");
    }
    return ok;
  } catch {
    return false;
  }
}
