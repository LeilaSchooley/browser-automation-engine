/**
 * Universal widget interaction primitive: open → select/fill → confirm → verify.
 */
import { humanPause } from "../human.js";
import {
  PLACEHOLDER_RE,
  extractSalaryDisplay,
  isCommittedValue,
  nearbyLabelText,
} from "./controlPatterns.js";
import { normalizeComboboxDisplay, readComboboxElementValue, readSalaryFromPage } from "./comboboxWidget.js";

/**
 * Universal widget interaction: route to handler → verify commit.
 * @param {import('playwright').Page} page
 * @param {object} spec
 * @param {string} value
 * @param {object} handlers
 * @param {{ snap?: object, log?: object }} [opts]
 */
export async function interactWidget(page, spec, value, handlers, opts = {}) {
  const mappedTo = spec.mappedTo || spec.type || "custom";
  const widgetType = spec.widgetType || (mappedTo === "salary" ? "combobox" : "text");
  const log = opts.log || null;
  const snap = opts.snap || null;
  const readSpec = {
    selector: spec.selector || spec.triggerSelector,
    widgetType,
  };

  if (
    mappedTo === "salary" ||
    mappedTo === "location" ||
    mappedTo === "relocatelocations" ||
    spec.requiresConfirm ||
    widgetType === "typeahead"
  ) {
    const live = await readControlValue(page, mappedTo, readSpec);
    if (live && isCommittedValue(live, mappedTo)) {
      return { ok: true, committed: true, value: live };
    }
  }

  let ok = false;
  if (widgetType === "combobox" || mappedTo === "salary" || mappedTo === "custom") {
    ok = await handlers.combobox(page, spec, value, log, snap);
  } else if (widgetType === "select") {
    ok = await handlers.select(page, spec, value, log, snap);
  } else if (widgetType === "checkbox") {
    ok = await (handlers.checkbox || handlers.radio)(page, spec, value, log, snap);
  } else if (widgetType === "typeahead") {
    ok = await handlers.typeahead(page, spec.labelRe, value, log, snap, spec);
  } else if (widgetType === "radio") {
    ok = await handlers.radio(page, spec, value, log, snap);
  } else if (widgetType === "yesno") {
    ok = await handlers.yesno(page, spec, value, log, snap);
  } else if (widgetType === "date") {
    ok = await handlers.date(page, spec.labelRe, value, log, snap);
  } else if (widgetType === "contenteditable") {
    ok = await handlers.contenteditable(page, spec.labelRe, value, log);
  } else {
    ok = await handlers.text(page, spec, value, log, snap);
  }

  if (!ok) return { ok: false, committed: false };

  const needsVerify = mappedTo === "salary" || spec.requiresConfirm;
  const committed = needsVerify
    ? await verifyCommitted(page, mappedTo, {
        ...readSpec,
        log,
        attempts: 6,
      })
    : true;

  return {
    ok: committed,
    committed,
    value: committed ? await readControlValue(page, mappedTo, readSpec) : "",
  };
}

/**
 * Read live value for any mapped control type.
 * @param {import('playwright').Page} page
 * @param {string} mappedTo
 * @param {{ selector?: string, widgetType?: string }} [spec]
 */
export async function readControlValue(page, mappedTo, spec = {}) {
  const m = String(mappedTo || "").toLowerCase();
  const selector = spec.selector || spec.triggerSelector || "";

  try {
    if (selector) {
      const loc = page.locator(selector).first();
      const fromSelector = await readComboboxElementValue(loc, m);
      if (fromSelector) return fromSelector;
      const blob = `${await loc.innerText().catch(() => "")} ${await loc.getAttribute("aria-label").catch(() => "")}`
        .replace(/\s+/g, " ")
        .trim();
      const normalized = m === "salary" ? extractSalaryDisplay(blob) : normalizeComboboxDisplay(blob, m);
      if (normalized) return normalized;
    }

    const dialogs = page.locator("[role='dialog'], [aria-modal='true']");
    const dialogCount = await dialogs.count().catch(() => 0);
    const roots = [];
    if (dialogCount > 0) {
      roots.push(dialogs.first());
      if (dialogCount > 1) roots.push(dialogs.last());
    }
    roots.push(page);

    if (m === "salary") {
      const fromPage = await readSalaryFromPage(page);
      if (fromPage) return fromPage;
    }

    for (const root of roots) {
      if (m === "salary") {
        try {
          const byRole = root.getByRole("combobox", { name: /salary|compensation|pay expect/i });
          if ((await byRole.count().catch(() => 0)) > 0) {
            const combo = byRole.first();
            if (await visible(combo)) {
              const extracted = await readComboboxElementValue(combo, "salary");
              if (extracted) return extracted;
            }
          }
        } catch {
          /* fall through */
        }

        const combos = root.locator("[role='combobox'], [aria-haspopup='listbox']");
        const count = await combos.count().catch(() => 0);
        for (let i = 0; i < count; i += 1) {
          const combo = combos.nth(i);
          if (!(await visible(combo))) continue;
          const blob = `${await combo.innerText().catch(() => "")} ${await combo.getAttribute("aria-label").catch(() => "")}`.replace(/\s+/g, " ").trim();
          const labelText = await nearbyLabelText(combo);
          const id = (await combo.getAttribute("id").catch(() => "")) || "";
          if (!isSalaryControl(blob, labelText, id)) continue;
          const extracted = await readComboboxElementValue(combo, "salary");
          if (extracted) return extracted;
          if (blob === "?" || PLACEHOLDER_RE.test(blob)) return "";
        }

        try {
          const dialogText = await root
            .locator("[role='dialog'], [aria-modal='true']")
            .first()
            .innerText({ timeout: 2000 })
            .catch(() => "");
          const fromDialog = extractSalaryDisplay(dialogText);
          if (fromDialog) return fromDialog;
        } catch {
          /* ignore */
        }
      }
      if (m === "location" || m === "relocatelocations" || m === "desiredtitle" || m === "country") {
        const inputs = root.locator(
          "input[type='text'], input:not([type]), textarea, input[role='combobox'], [role='combobox']",
        );
        const count = await inputs.count().catch(() => 0);
        for (let i = 0; i < count; i += 1) {
          const input = inputs.nth(i);
          const aria = (await input.getAttribute("aria-label").catch(() => "")) || "";
          const placeholder = (await input.getAttribute("placeholder").catch(() => "")) || "";
          const labelNear = await nearbyLabelText(input);
          const blob = `${placeholder} ${aria} ${labelNear}`.toLowerCase();
          const match =
            m === "location"
              ? /\blocation\b|where are you|based in|what city|which city|city do you live|live in|hometown/i.test(
                  blob,
                )
              : m === "relocatelocations"
                ? /where else|relocat|cities|regions|countries/i.test(blob)
                : m === "country"
                  ? /\bcountry\b/i.test(blob)
                  : /desired job|job title/i.test(blob);
          if (!match) continue;
          const fromCombo = await readComboboxElementValue(input, m);
          if (fromCombo) return fromCombo;
          const val =
            (await input.inputValue().catch(() => "")) || (await input.innerText().catch(() => ""));
          const trimmed = String(val).replace(/\s+/g, " ").trim();
          if (isCommittedValue(trimmed, m)) return trimmed;
        }
      }
      if (m === "custom" || (!["salary", "location", "desiredtitle", "country"].includes(m) && spec.widgetType === "text")) {
        const inputs = root.locator("input[type='text'], input:not([type]), textarea");
        const count = await inputs.count().catch(() => 0);
        for (let i = 0; i < count; i += 1) {
          const input = inputs.nth(i);
          const val = await input.inputValue().catch(() => "");
          const trimmed = String(val).replace(/\s+/g, " ").trim();
          if (isCommittedValue(trimmed, m)) return trimmed;
        }
      }
    }
  } catch {
    /* ignore */
  }
  return "";
}

/** Backward-compatible alias. */
export const readLiveControlValue = readControlValue;

async function visible(loc) {
  return loc.isVisible({ timeout: 900 }).catch(() => false);
}

function isSalaryControl(blob, labelText, id = "") {
  const hay = `${labelText} ${blob} ${id}`.toLowerCase();
  return (
    /salary|compensation|pay expect/i.test(hay) ||
    blob === "?" ||
    PLACEHOLDER_RE.test(blob) ||
    /salary/i.test(id)
  );
}

/**
 * Poll until control value is committed or timeout.
 * @param {import('playwright').Page} page
 * @param {string} mappedTo
 * @param {{ selector?: string, widgetType?: string, attempts?: number, log?: object }} [opts]
 */
export async function verifyCommitted(page, mappedTo, opts = {}) {
  const log = opts.log || null;
  const attempts = opts.attempts ?? 6;
  for (let i = 0; i < attempts; i += 1) {
    await humanPause(i === 0 ? 320 : 300, i === 0 ? 580 : 480);
    const live = await readControlValue(page, mappedTo, opts);
    if (live) {
      log?.layer("widget", `verified ${mappedTo}="${live.slice(0, 40)}"`, "info");
      return true;
    }
  }
  return false;
}

/**
 * Check whether a mapped control is committed on the page.
 * @param {import('playwright').Page} page
 * @param {string} mappedTo
 * @param {object} [spec]
 */
export async function controlCommittedOnPage(page, mappedTo, spec = {}) {
  const live = await readControlValue(page, mappedTo, spec);
  return !!live;
}
