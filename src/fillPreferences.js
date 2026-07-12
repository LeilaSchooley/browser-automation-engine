import { resolveSalaryExpectation } from "./salaryExpectation.js";

export function getPreferencesFromContext(context = {}) {
  const p = context.preferences || {};
  const applicant = context.applicant || context.profile || {};
  const job = context.job || {};

  const city = String(p.city || applicant.city || "").trim();
  const country = String(p.country || applicant.country || "").trim();
  const location =
    String(p.location || "").trim() ||
    [city, country].filter(Boolean).join(", ") ||
    String(job.location || "").trim();

  const desiredTitle =
    String(p.desiredTitle || p.desiredJobTitle || "").trim() || String(job.title || context.title || "").trim();

  const salary = resolveSalaryExpectation(context);

  return {
    location,
    desiredTitle,
    desiredJobTitle: desiredTitle,
    salary,
    salaryExpectation: salary,
    country,
    city,
  };
}

export function preferencesPromptBlock(context) {
  const p = getPreferencesFromContext(context);
  return `JOB PREFERENCES (use ONLY when fields ask — never invent):
- Location: ${p.location || "(none)"}
- Desired job title: ${p.desiredTitle || "(none)"}
- Salary expectations: ${p.salary || "(derive from job listing or leave for AI)"}`;
}

/** Map label/target to a preference value. */
export function resolvePreferenceFillValue(targetHint, proposedValue, context) {
  const p = getPreferencesFromContext(context);
  const blob = String(targetHint || "").toLowerCase();
  if (/desired\s*job|job\s*title|role\s*you|position\s*sought|target\s*role/i.test(blob)) {
    return p.desiredTitle || proposedValue;
  }
  if (/\blocation\b|where\s*are\s*you|based\s*in|city\s*region/i.test(blob)) {
    return p.location || proposedValue;
  }
  if (/salary|compensation|pay\s*expect|expected\s*pay/i.test(blob)) {
    return p.salary || proposedValue;
  }
  if (/\bcountry\b|region\s*code/i.test(blob) && !/location/.test(blob)) {
    return p.country || proposedValue;
  }
  return proposedValue;
}

const PREF_FIELD_RE =
  /desired\s*job|job\s*title|salary|compensation|pay\s*expect|\blocation\b|where\s*are\s*you|based\s*in/i;

/** Modal / step asking for job-search preferences (not identity signup). */
export function hasPreferencesGateFields(snap) {
  if (!snap || (snap.passwordFieldCount || 0) > 0) return false;

  const blob = `${snap.applyModalTitle || ""} ${snap.title || ""} ${snap.pageText || ""} ${snap.headings || ""}`.toLowerCase();
  const tellUs = /tell us about yourself|your preferences|job preferences|before you continue/i.test(blob);

  if (tellUs) return true;
  if ((snap.customControlCount || 0) >= 1 && tellUs) return true;

  if ((snap.fieldCount || 0) < 2 && !tellUs && (snap.customControlCount || 0) < 1) return false;

  const fieldLabels = (snap.fields || [])
    .map((f) => `${f.label || ""} ${f.name || ""} ${f.placeholder || ""}`.toLowerCase())
    .join(" ");

  const prefFields = (fieldLabels.match(new RegExp(PREF_FIELD_RE.source, "gi")) || []).length;
  const hasSalary = /salary|compensation|pay\s*expect/i.test(fieldLabels) || /salary expectation/i.test(blob);
  const hasLocation = /\blocation\b|where are you/i.test(fieldLabels);
  const hasTitle = /desired job|job title/i.test(fieldLabels);

  return tellUs || (prefFields >= 2) || (hasLocation && (hasSalary || hasTitle));
}

function fieldLooksEmpty(f) {
  if (!f) return true;
  if (f.type === "select") return !f.filled;
  return !f.filled;
}

function fieldMatchesPrefKind(label) {
  const b = String(label || "").toLowerCase();
  if (/desired\s*job|job\s*title|target\s*role/i.test(b)) return "desiredTitle";
  if (/salary|compensation|pay\s*expect/i.test(b)) return "salary";
  if (/\blocation\b|where\s*are\s*you|based\s*in/i.test(b)) return "location";
  return null;
}

/** True when a preferences gate still has empty required-looking fields. */
export function preferencesGateIncomplete(snap, fillResult = null) {
  if (!hasPreferencesGateFields(snap)) return false;

  const unfilledTypes = new Set((fillResult?.unfilled || []).map((u) => u.type));
  if (unfilledTypes.has("salary") || unfilledTypes.has("location") || unfilledTypes.has("desiredtitle")) {
    return true;
  }

  for (const f of snap.fields || []) {
    const kind = fieldMatchesPrefKind(`${f.label || ""} ${f.name || ""}`);
    if (kind && fieldLooksEmpty(f)) return true;
    if (fieldLooksEmpty(f) && (f.type === "select" || f.type === "SELECT")) return true;
    const label = String(f.label || "").trim();
    if (fieldLooksEmpty(f) && (!label || label === "?")) return true;
  }

  for (const c of snap.customControls || []) {
    if (!c.filled) return true;
  }

  return false;
}
