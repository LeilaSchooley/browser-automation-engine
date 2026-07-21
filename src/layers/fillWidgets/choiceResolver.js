/**
 * Semantic option-resolver glue: collect unmapped choice groups (radio / select
 * / checkbox) surfaced by perception, and apply an LLM-picked option back onto
 * the page. The resolver itself (LLM) is injected via the runtime as
 * `answerChoiceFields`; this module only shapes input and applies output so the
 * model is always grounded in the real, visible options.
 */
import { fillApplicationRadio } from "./radio.js";
import { fillSelectControl } from "./select.js";

/** Unmapped, unfilled choice controls with concrete options, minus already-seen. */
export function collectUnmappedChoiceControls(snap, seen = new Set()) {
  const controls = snap?.customControls || [];
  const out = [];
  for (const c of controls) {
    if (!c || !c.unmapped) continue;
    if (c.filled) continue;
    if (!Array.isArray(c.options) || c.options.length < 2) continue;
    const selector = c.selector || c.triggerSelector || "";
    if (!selector || seen.has(selector)) continue;
    out.push(c);
  }
  return out;
}

/** Compact, model-facing spec (never leak selectors into option text). */
export function buildChoiceSpecs(controls) {
  return controls.map((c) => ({
    selector: c.selector || c.triggerSelector || "",
    questionLabel: c.questionLabel || c.label || "",
    widgetType: c.widgetType || "radio",
    multiple: c.widgetType === "checkbox",
    options: (c.options || [])
      .map((o) => (typeof o === "string" ? o : o.text || ""))
      .map((t) => String(t || "").trim())
      .filter(Boolean),
  }));
}

/** Authoritative required-field name hints (e.g. WaaS serverErrors) when present. */
export function requiredHintsFromSnap(snap) {
  const v = snap?.waasValidation || null;
  if (v && Array.isArray(v.missing) && v.missing.length) return v.missing.slice();
  const errs = v?.serverErrors || null;
  if (errs && typeof errs === "object") {
    return Object.keys(errs).filter((k) => Array.isArray(errs[k]) && errs[k].length > 0);
  }
  return [];
}

/**
 * Apply a resolved option to its control. `chosen` must be one of the control's
 * option texts (the resolver is constrained to echo an exact option).
 * @param {import('playwright').Page} page
 */
export async function applyResolvedChoice(page, control, chosen, log = null, snap = null) {
  const value = String(chosen || "").trim();
  if (!value || /^skip$/i.test(value)) return false;
  const spec = {
    label: control.label || control.questionLabel || "",
    questionLabel: control.questionLabel || control.label || "",
    mappedTo: "choice",
    selector: control.selector || control.triggerSelector || "",
    triggerSelector: control.triggerSelector || control.selector || "",
    widgetType: control.widgetType || "radio",
  };
  try {
    if (spec.widgetType === "select") {
      return await fillSelectControl(page, spec, value, log, snap);
    }
    // radio + checkbox both resolve by clicking the option label matching text.
    return await fillApplicationRadio(page, spec, value, log, snap);
  } catch {
    return false;
  }
}
