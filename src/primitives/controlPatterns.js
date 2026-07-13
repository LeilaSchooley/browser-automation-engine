/**
 * Single source of truth for control label maps, confirm patterns, placeholders, and DOM helpers.
 */

export const LABEL_TO_MAPPED = [
  { re: /desired\s*job|job\s*title|target\s*role|position\s*sought/i, mappedTo: "desiredtitle", type: "desiredtitle" },
  { re: /salary|compensation|pay\s*expect|expected\s*pay/i, mappedTo: "salary", type: "salary" },
  { re: /\blocation\b|where\s*are\s*you|based\s*in|city\s*region/i, mappedTo: "location", type: "location" },
  { re: /\bcountry\b/i, mappedTo: "country", type: "country" },
];

/** Visa / EEOC application questions (Ashby-style yes/no and fieldset radios). */
export const APPLICATION_LABEL_TO_MAPPED = [
  {
    re: /visa|work\s*authorization|require.*sponsor|sponsorship|legally\s*authorized/i,
    mappedTo: "visasponsorship",
    type: "visasponsorship",
  },
  { re: /gender\s*identity|\bgender\b/i, mappedTo: "eeocgender", type: "eeocgender" },
  { re: /race|ethnic/i, mappedTo: "eeocrace", type: "eeocrace" },
  { re: /veteran/i, mappedTo: "eeocveteran", type: "eeocveteran" },
  { re: /disabilit/i, mappedTo: "eeocdisability", type: "eeocdisability" },
];

export const SIGNUP_CTA_PATTERNS = [/sign up now/i, /sign up for free/i, /get started/i, /^continue$/i];

/** Strict confirm-button patterns for picker commit (anchored). */
export const PICKER_CONFIRM_PATTERNS = [
  /^save$/i,
  /^apply$/i,
  /^ok$/i,
  /^done$/i,
  /^confirm$/i,
  /^submit$/i,
  /^set$/i,
  /^add$/i,
  /^select$/i,
  /^done selecting$/i,
  /^übernehmen$/i,
  /^valider$/i,
];

/** Looser confirm text for scoring discovered buttons. */
export const CONFIRM_TEXT =
  /\b(save|done|ok|confirm|apply|submit|set|add|select|übernehmen|valider|aceptar|guardar|speichern)\b/i;

export const CONFIRM_TEXT_STRICT =
  /^(save|done|ok|confirm|apply|submit|set|add|select|done selecting|übernehmen|valider)$/i;

export const PLACEHOLDER_RE = /^(salary expectations|select|choose|\?)$/i;

export const SALARY_COMMITTED_RE = /USD|€|£|\$[\d,]+|€[\d,]+|£[\d,]+|negotiable|flexible|\d{2,}[, ]/i;

/** Minimum successful runs before replaying a learned control skill. */
export const MIN_CONTROL_SKILL_SUCCESS = 2;

/**
 * Map a label blob to { mappedTo, type }.
 * @param {string} label
 */
export function mapLabelToMapped(label) {
  const blob = String(label || "").toLowerCase();
  for (const { re, mappedTo, type } of LABEL_TO_MAPPED) {
    if (re.test(blob)) return { mappedTo, type };
  }
  return null;
}

export function mapApplicationLabelToMapped(label) {
  const blob = String(label || "").toLowerCase();
  for (const { re, mappedTo, type } of APPLICATION_LABEL_TO_MAPPED) {
    if (re.test(blob)) return { mappedTo, type };
  }
  return null;
}

/**
 * Walk DOM for nearby label text of a control element.
 * @param {import('playwright').Locator} loc
 */
export async function nearbyLabelText(loc) {
  return loc
    .evaluate((node) => {
      const prev = node.previousElementSibling;
      if (prev?.tagName === "LABEL") return (prev.textContent || "").trim();
      const lbl = node.closest("label");
      if (lbl) return (lbl.textContent || "").trim();
      const id = node.id;
      if (id) {
        const forLbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (forLbl) return (forLbl.textContent || "").trim();
      }
      let sib = node.previousElementSibling;
      while (sib) {
        if (sib.tagName === "LABEL") return (sib.textContent || "").trim();
        sib = sib.previousElementSibling;
      }
      return "";
    })
    .catch(() => "");
}

/**
 * Whether a value looks like a committed (non-placeholder) control value.
 * @param {string} value
 * @param {string} [mappedTo]
 */
export function isCommittedValue(value, mappedTo = "") {
  const trimmed = String(value || "").replace(/\s+/g, " ").trim();
  if (!trimmed || PLACEHOLDER_RE.test(trimmed)) return false;
  if (mappedTo === "salary") return SALARY_COMMITTED_RE.test(trimmed);
  return trimmed.length > 0 && !/^select|choose$/i.test(trimmed);
}

/** Pull a committed salary band out of combobox / floating-label text. */
export function extractSalaryDisplay(blob) {
  const trimmed = String(blob || "").replace(/\s+/g, " ").trim();
  if (!trimmed) return "";
  const stripped = trimmed.replace(/^salary expectations\s*/i, "").trim();
  if (isCommittedValue(stripped, "salary")) return stripped;
  const match = trimmed.match(
    /(?:(?:USD|EUR|GBP|€|£|\$)\s*[\d,]+|\$[\d,]+)(?:\s*[-–—]\s*(?:(?:USD|EUR|GBP|€|£|\$)\s*[\d,]+|\$[\d,]+|\d[\d,]+))?/i,
  );
  if (match && isCommittedValue(match[0], "salary")) return match[0].trim();
  return "";
}

/**
 * Design-system / behavioral button selectors (not site-specific).
 */
export const BEHAVIORAL_BUTTON_SEL =
  "button, [role='button'], div.ds-button, [class*='ds-button' i], [class*='btn' i]";
