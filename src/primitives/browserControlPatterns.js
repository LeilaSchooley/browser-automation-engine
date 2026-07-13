/**
 * Browser-context helpers serialized from Node primitives for page.evaluate / smart_fill eval.
 */
import { APPLICATION_LABEL_TO_MAPPED, LABEL_TO_MAPPED, PLACEHOLDER_RE } from "./controlPatterns.js";
import { parseSalaryNumbers } from "../salaryExpectation.js";

/** Serializable label rules for in-browser mapComboboxLabel. */
export function serializeLabelRules() {
  return LABEL_TO_MAPPED.map(({ re, mappedTo, type }) => ({
    pattern: re.source,
    flags: re.flags || "i",
    mappedTo,
    type,
  }));
}

export function serializeApplicationLabelRules() {
  return APPLICATION_LABEL_TO_MAPPED.map(({ re, mappedTo, type }) => ({
    pattern: re.source,
    flags: re.flags || "i",
    mappedTo,
    type,
  }));
}

/** Args bundle for formDiscovery scanDom evaluate. */
export function browserPatternArgs() {
  return {
    labelRules: serializeLabelRules(),
    applicationLabelRules: serializeApplicationLabelRules(),
    placeholderPatternSource: PLACEHOLDER_RE.source,
    placeholderPatternFlags: PLACEHOLDER_RE.flags || "i",
  };
}

/** In-browser nearby label walk (sync DOM, mirrors nearbyLabelText). */
export const NEARBY_LABEL_FN_BODY = `
function nearbyFieldLabel(el) {
  const prev = el.previousElementSibling;
  if (prev?.tagName === "LABEL") return (prev.textContent || "").trim();
  const lbl = el.closest("label");
  if (lbl) return (lbl.textContent || "").trim();
  const id = el.id;
  if (id) {
    const forLbl = document.querySelector('label[for="' + CSS.escape(id) + '"]');
    if (forLbl) return (forLbl.textContent || "").trim();
  }
  let sib = el.previousElementSibling;
  while (sib) {
    if (sib.tagName === "LABEL") return (sib.textContent || "").trim();
    sib = sib.previousElementSibling;
  }
  return "";
}
`;

/** In-browser mapComboboxLabel using injected labelRules array. */
export const MAP_LABEL_FN_BODY = `
function mapComboboxLabel(label, labelRules) {
  const blob = (label || "").toLowerCase();
  for (const rule of labelRules || []) {
    if (new RegExp(rule.pattern, rule.flags || "i").test(blob)) {
      return { mappedTo: rule.mappedTo, type: rule.type };
    }
  }
  return { mappedTo: "custom", type: "custom" };
}
`;

/**
 * Salary option picker for in-browser smart_fill (parity with pickClosestSalaryOption).
 * @param {Array<{ value: string, text: string }>} options
 * @param {string} target
 */
export function pickClosestSalaryOptionInBrowser(options, target) {
  const opts = (options || []).filter((o) => o && String(o.text || "").trim());
  if (!opts.length) return null;

  const targetNums = parseSalaryNumbers(target);
  const mid = targetNums.length
    ? (Math.min(...targetNums) + Math.max(...targetNums)) / 2
    : 0;

  const lowerTarget = String(target || "").toLowerCase().trim();
  if (lowerTarget) {
    const exact =
      opts.find((o) => o.text.trim().toLowerCase() === lowerTarget) ||
      opts.find((o) => o.value.toLowerCase() === lowerTarget) ||
      (lowerTarget.length >= 3 ? opts.find((o) => o.text.toLowerCase().includes(lowerTarget)) : null);
    if (exact) return exact;
  }

  if (!mid) return null;

  let best = null;
  let bestDist = Infinity;
  for (const o of opts) {
    const nums = parseSalaryNumbers(o.text);
    if (!nums.length) continue;
    const lo = Math.min(...nums);
    const hi = Math.max(...nums);
    if (mid >= lo && mid <= hi) return o;
    const dist = mid < lo ? lo - mid : mid - hi;
    if (dist < bestDist) {
      bestDist = dist;
      best = o;
    }
  }
  return best;
}

/** Script injected before smart_fill eval for salary select parity. */
export const SMART_FILL_SALARY_HELPER = `
function __pickClosestSalaryOption(options, target) {
  const parseNums = (text) => {
    const nums = [];
    const s = String(text || "").toLowerCase().replace(/,/g, "");
    let m;
    const reK = /[$£€]?\\s*(\\d+(?:\\.\\d+)?)\\s*k\\b/gi;
    while ((m = reK.exec(s))) nums.push(Math.round(parseFloat(m[1]) * 1000));
    const reFull = /[$£€]\\s*(\\d{2,3})(\\d{3})\\b/g;
    while ((m = reFull.exec(s))) nums.push(parseInt(m[1] + m[2], 10));
    return nums.filter((n) => n >= 1000);
  };
  const opts = (options || []).filter((o) => o && String(o.text || "").trim());
  if (!opts.length) return null;
  const targetNums = parseNums(target);
  const mid = targetNums.length
    ? (Math.min.apply(null, targetNums) + Math.max.apply(null, targetNums)) / 2
    : 0;
  const lowerTarget = String(target || "").toLowerCase().trim();
  if (lowerTarget) {
    const exact =
      opts.find((o) => o.text.trim().toLowerCase() === lowerTarget) ||
      opts.find((o) => o.value.toLowerCase() === lowerTarget) ||
      (lowerTarget.length >= 3 ? opts.find((o) => o.text.toLowerCase().includes(lowerTarget)) : null);
    if (exact) return exact;
  }
  if (!mid) return null;
  let best = null;
  let bestDist = Infinity;
  for (const o of opts) {
    const nums = parseNums(o.text);
    if (!nums.length) continue;
    const lo = Math.min.apply(null, nums);
    const hi = Math.max.apply(null, nums);
    if (mid >= lo && mid <= hi) return o;
    const dist = mid < lo ? lo - mid : mid - hi;
    if (dist < bestDist) { bestDist = dist; best = o; }
  }
  return best;
}
`;
