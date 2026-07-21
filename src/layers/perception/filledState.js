/**
 * DOM state-based "filled" detection — trust selection/commit state, not visible
 * option text or question labels (WaaS RadioGroups, Places typeaheads, etc.).
 *
 * Used in page.evaluate (scanDom) and in Node-side reconciliation.
 */

/** @param {Element|null|undefined} el */
export function isElementFilledState(el) {
  if (!el) return false;
  const tag = String(el.tagName || "").toLowerCase();
  const type = String(el.type || "").toLowerCase();
  const role = String(el.getAttribute?.("role") || "").toLowerCase();

  if (type === "checkbox" || type === "radio") return !!el.checked;
  if (role === "radio") return el.getAttribute("aria-checked") === "true";
  if (role === "checkbox") return el.getAttribute("aria-checked") === "true";
  if (tag === "select") return String(el.value || "").trim() !== "";

  const ariaExpanded = el.getAttribute?.("aria-expanded");
  const val = String(el.value ?? "").replace(/\s+/g, " ").trim();

  if (role === "combobox" || type === "text" || tag === "input" || tag === "textarea") {
    if (ariaExpanded === "true") return false;
    if (isLocationLikeInput(el) && val) return isLocationValueCommitted(val);
    if (val && !/^search\b/i.test(val)) return true;
  }

  if (el.getAttribute?.("aria-selected") === "true") return true;
  if (el.getAttribute?.("aria-checked") === "true") return true;

  return false;
}

/** @param {Element} el */
function isLocationLikeInput(el) {
  const aria = String(el.getAttribute?.("aria-label") || "").toLowerCase();
  const name = String(el.getAttribute?.("name") || "").toLowerCase();
  const placeholder = String(el.getAttribute?.("placeholder") || "").toLowerCase();
  const blob = `${aria} ${name} ${placeholder}`;
  return /city|location|live in|hometown|placesautocomplete/i.test(blob);
}

/**
 * A committed Places / location chip — not raw search text.
 * @param {string} value
 */
export function isLocationValueCommitted(value) {
  const trimmed = String(value || "").replace(/\s+/g, " ").trim();
  if (!trimmed || trimmed.length < 2) return false;
  if (/^(what|where|search)\b/i.test(trimmed)) return false;
  if (trimmed.includes(",")) return true;
  if (/\S\s+\S/.test(trimmed) && trimmed.length >= 3) return true;
  return false;
}

/**
 * Radio group filled iff at least one option in scope is actually selected.
 * @param {Element} rootEl
 */
export function radioGroupFilledFromState(rootEl) {
  if (!rootEl) return false;
  const radios = [...rootEl.querySelectorAll("input[type='radio'], [role='radio']")];
  if (radios.some((r) => isElementFilledState(r))) return true;
  return false;
}

/**
 * Combobox / typeahead filled from element state (value + aria-expanded).
 * @param {Element} el
 * @param {string} [mappedTo]
 */
export function comboboxFilledFromState(el, mappedTo = "") {
  if (!el) return false;
  const role = String(el.getAttribute?.("role") || "").toLowerCase();
  const tag = String(el.tagName || "").toLowerCase();
  const target = tag === "input" || tag === "textarea" ? el : el.querySelector?.("input, textarea") || el;
  const val = String(target?.value ?? el.textContent ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const expanded = (target || el).getAttribute?.("aria-expanded") === "true";
  if (expanded) return false;
  const mapped = String(mappedTo || "").toLowerCase();
  if (mapped === "location" || mapped === "relocatelocations" || isLocationLikeInput(target || el)) {
    return isLocationValueCommitted(val);
  }
  return val.length > 1 && !/^search\b/i.test(val);
}

/** Serialize helpers for injection into page.evaluate. */
export function filledStateHelperSource() {
  return `
    function __isLocationValueCommitted(value) {
      const trimmed = String(value || "").replace(/\\s+/g, " ").trim();
      if (!trimmed || trimmed.length < 2) return false;
      if (/^(what|where|search)\\b/i.test(trimmed)) return false;
      if (trimmed.includes(",")) return true;
      if (/\\S\\s+\\S/.test(trimmed) && trimmed.length >= 3) return true;
      return false;
    }
    function __isElementFilledState(el) {
      if (!el) return false;
      const tag = String(el.tagName || "").toLowerCase();
      const type = String(el.type || "").toLowerCase();
      const role = String(el.getAttribute("role") || "").toLowerCase();
      if (type === "checkbox" || type === "radio") return !!el.checked;
      if (role === "radio" || role === "checkbox") return el.getAttribute("aria-checked") === "true";
      if (tag === "select") return String(el.value || "").trim() !== "";
      const ariaExpanded = el.getAttribute("aria-expanded");
      const val = String(el.value ?? "").replace(/\\s+/g, " ").trim();
      if (role === "combobox" || type === "text" || tag === "input" || tag === "textarea") {
        if (ariaExpanded === "true") return false;
        const aria = String(el.getAttribute("aria-label") || "").toLowerCase();
        const name = String(el.getAttribute("name") || "").toLowerCase();
        if (/city|location|live in|hometown|placesautocomplete/i.test(aria + " " + name) && val) {
          return __isLocationValueCommitted(val);
        }
        if (val && !/^search\\b/i.test(val)) return true;
      }
      if (el.getAttribute("aria-selected") === "true") return true;
      return false;
    }
    function __radioGroupFilledFromState(rootEl) {
      if (!rootEl) return false;
      const radios = [...rootEl.querySelectorAll("input[type='radio'], [role='radio']")];
      return radios.some((r) => __isElementFilledState(r));
    }
  `;
}
