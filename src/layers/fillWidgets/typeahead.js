/**
 * Typeahead / autocomplete custom control filler.
 */
import { humanPause, humanType } from "../../human.js";
import { isCommittedValue } from "../../primitives/controlPatterns.js";
import { readComboboxElementValue } from "../../primitives/comboboxWidget.js";
import { fillComboboxControl } from "./combobox.js";
import { scopedDialog, visible } from "./shared.js";

const SCHOOL_OR_EDU_RE =
  /school|university|college|bootcamp|institute|academy|education|graduat|attend/i;
const LOCATION_LABEL_RE =
  /location|where are you|based in|what city|which city|city do you live|live in|hometown|city_current|placesautocomplete/i;

async function inputLabelBlob(input) {
  if (!input) return "";
  return input
    .evaluate((el) => {
      const aria = el.getAttribute("aria-label") || "";
      const name = el.getAttribute("name") || "";
      const ph = el.getAttribute("placeholder") || "";
      const id = el.id || "";
      let forLabel = "";
      if (id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        forLabel = lbl?.textContent || "";
      }
      const wrap = el.closest("label, .field, [class*='field'], div")?.querySelector("label");
      const near = wrap?.textContent || el.closest("label")?.textContent || "";
      return `${aria} ${name} ${ph} ${forLabel} ${near}`.replace(/\s+/g, " ").trim();
    })
    .catch(() => "");
}

async function isSchoolOrEduInput(input) {
  const blob = await inputLabelBlob(input);
  return SCHOOL_OR_EDU_RE.test(blob);
}

async function isLocationLikeInput(input) {
  const blob = await inputLabelBlob(input);
  if (SCHOOL_OR_EDU_RE.test(blob)) return false;
  return LOCATION_LABEL_RE.test(blob);
}

async function readTypeaheadCommitted(input, mappedTo, token) {
  // An open suggestion dropdown means the user is still searching — the value is
  // raw typed text (e.g. Google Places "LONDON"), not a committed "London, UK"
  // chip. Treat it as uncommitted so we pick a real suggestion.
  const expanded = await input.getAttribute("aria-expanded").catch(() => null);
  if (expanded === "true") return "";
  // Never treat school/education inputs as a committed city.
  if ((mappedTo === "location" || mappedTo === "relocatelocations") && (await isSchoolOrEduInput(input))) {
    return "";
  }
  const fromCombo = await readComboboxElementValue(input, mappedTo || "location");
  if (fromCombo && isCommittedValue(fromCombo, mappedTo || "location")) return fromCombo;
  const val = String((await input.inputValue().catch(() => "")) || "")
    .replace(/\s+/g, " ")
    .trim();
  if (val && isCommittedValue(val, mappedTo || "location")) return val;
  // Parent host often holds the Places chip after select (input cleared).
  const hostText = await input
    .evaluate((node) => {
      const host =
        node.closest("[role='combobox'], [class*='select' i], [class*='places' i], label, div") ||
        node.parentElement;
      return (host?.innerText || host?.textContent || "").replace(/\s+/g, " ").trim();
    })
    .catch(() => "");
  if (token && hostText && new RegExp(token.slice(0, 12).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(hostText)) {
    if (!SCHOOL_OR_EDU_RE.test(hostText)) return hostText.slice(0, 80);
  }
  if (hostText && isCommittedValue(hostText, mappedTo || "location") && !SCHOOL_OR_EDU_RE.test(hostText)) {
    return hostText.slice(0, 80);
  }
  return "";
}

function queryToken(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  // Prefer city token before country/code for Places-style suggestions.
  return raw.split(",")[0].trim() || raw;
}

async function resolveTypeaheadInput(root, page, labelRe, selector, mappedTo = "") {
  const wantLocation = mappedTo === "location" || mappedTo === "relocatelocations";

  if (selector) {
    const host = page.locator(selector).first();
    if ((await host.count().catch(() => 0)) > 0 && (await visible(host))) {
      const nested = host.locator("input").first();
      if ((await nested.count().catch(() => 0)) > 0 && (await visible(nested))) {
        if (wantLocation && (await isSchoolOrEduInput(nested))) {
          /* fall through — selector pointed at school */
        } else {
          return nested;
        }
      }
      const tag = await host.evaluate((el) => el.tagName?.toLowerCase() || "").catch(() => "");
      if (tag === "input") {
        if (!(wantLocation && (await isSchoolOrEduInput(host)))) return host;
      }
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
      const count = await loc.count().catch(() => 0);
      for (let i = 0; i < Math.min(count, 8); i += 1) {
        const el = loc.nth(i);
        if (!(await visible(el))) continue;
        const tag = await el.evaluate((node) => node.tagName?.toLowerCase() || "").catch(() => "");
        let input = el;
        if (tag !== "input" && tag !== "textarea") {
          const nested = el.locator("input, textarea").first();
          if ((await nested.count().catch(() => 0)) === 0 || !(await visible(nested))) continue;
          input = nested;
        }
        if (wantLocation) {
          if (await isSchoolOrEduInput(input)) continue;
          if (!(await isLocationLikeInput(input))) continue;
        }
        return input;
      }
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
    const mappedTo = spec.mappedTo || "location";
    const input = await resolveTypeaheadInput(
      root,
      page,
      re,
      spec.triggerSelector || spec.selector || "",
      mappedTo,
    );
    if (!input) {
      // Portaled / static listbox comboboxes have no nested input — use combobox pick path.
      // Never fall through to a random combobox when location couldn't find a city field
      // (Role step: school autocomplete must not absorb city fill).
      if (mappedTo === "location" || mappedTo === "relocatelocations") return false;
      return fillComboboxControl(
        page,
        {
          label: String(labelRe?.source || labelRe || "location"),
          mappedTo,
          value: token,
          triggerSelector: spec.triggerSelector || spec.selector,
          requiresConfirm: false,
        },
        log,
        snap,
      );
    }

    const already = await readTypeaheadCommitted(input, mappedTo, token);
    if (already) {
      log?.layer?.(
        "custom_controls",
        `${mappedTo} already set: ${already.slice(0, 40)} — skip retype`,
        "info",
      );
      return true;
    }

    await input.click({ timeout: 3000 });
    await input.fill("").catch(() => {});
    await humanType(input, token, page);
    // Places / Algolia suggestions often need >500ms after typing.
    await humanPause(900, 1600);
    let ok = await pickSuggestion(page, token);
    if (!ok) {
      await humanPause(700, 1100);
      ok = await pickSuggestion(page, token);
    }
    if (ok) {
      log?.layer?.("custom_controls", `typeahead selected for "${token}"`, "info");
      await humanPause(400, 700);
    }
    return ok;
  } catch {
    return false;
  }
}
