import { resolveSalaryExpectation } from "./salaryExpectation.js";
import { looksLikeJobBoardIndex } from "./heuristics.js";

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
  if (
    /\blocation\b|where\s*are\s*you|based\s*in|city\s*region|what\s*city|which\s*city|city\s*do\s*you\s*live|live\s*in\b|hometown/i.test(
      blob,
    )
  ) {
    return p.city || p.location || proposedValue;
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
  /desired\s*job|job\s*title|salary|compensation|pay\s*expect|\blocation\b|where\s*are\s*you|based\s*in|what\s*city|city\s*do\s*you\s*live|live\s*in\b/i;

const PREF_CUSTOM_MAPPED = new Set(["salary", "location", "desiredtitle", "country"]);

/** Modal / step asking for job-search preferences (not identity signup or board filters). */
export function hasPreferencesGateFields(snap) {
  if (!snap || (snap.passwordFieldCount || 0) > 0) return false;

  // Ashby/Greenhouse/Lever board filters look like location/title fields but are not preferences gates.
  if (looksLikeJobBoardIndex(snap)) return false;

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
  const hasTitle = /desired job|job title|target role|position sought/i.test(fieldLabels);
  const selectOnly =
    (snap.fields || []).length >= 2 &&
    (snap.fields || []).every((f) => /select/i.test(String(f.type || ""))) &&
    (snap.fileInputCount || 0) === 0;

  // Filter-only Location + Department/Title selects without salary or tell-us copy ≠ prefs gate.
  if (selectOnly && !hasSalary && !tellUs) return false;

  return tellUs || (prefFields >= 2 && hasSalary) || (hasLocation && hasSalary) || (hasTitle && hasSalary);
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

/** True when a preferences gate still has empty required-looking fields (snapshot/fillResult only). */
export function preferencesGateIncomplete(snap, fillResult = null) {
  if (!hasPreferencesGateFields(snap)) return false;

  const unfilledTypes = new Set((fillResult?.unfilled || []).map((u) => u.type));
  if (unfilledTypes.has("salary") || unfilledTypes.has("location") || unfilledTypes.has("desiredtitle")) {
    return true;
  }

  for (const f of snap.fields || []) {
    const kind = fieldMatchesPrefKind(`${f.label || ""} ${f.name || ""}`);
    if (kind && fieldLooksEmpty(f)) return true;
  }

  // Only prefs-mapped custom widgets block the gate — not visa/EEOC leftovers.
  for (const c of snap.customControls || []) {
    if (c.filled) continue;
    const mapped = String(c.mappedTo || c.type || "").toLowerCase();
    if (PREF_CUSTOM_MAPPED.has(mapped)) return true;
  }

  return false;
}

/** Live DOM check for preferences gate (use when page is available). */
export async function preferencesGateIncompleteLive(page, snap, fillResult = null) {
  if (!hasPreferencesGateFields(snap)) return false;
  if (preferencesGateIncomplete(snap, fillResult)) {
    const { readLiveControlValue } = await import("./fillCustomControls.js");
    const { readSalaryFromPage } = await import("./primitives/comboboxWidget.js");
    const salaryLive = (await readSalaryFromPage(page)) || (await readLiveControlValue(page, "salary"));
    const locationLive = await readLiveControlValue(page, "location");
    const titleLive = await readLiveControlValue(page, "desiredtitle");
    if (salaryLive && locationLive && titleLive) return false;
    if (!salaryLive) return true;
    const needsLocation = (snap.fields || []).some((f) => /\blocation\b/i.test(`${f.label || ""}`));
    const needsTitle = (snap.fields || []).some((f) => /job title|desired/i.test(`${f.label || ""}`));
    if (needsLocation && !locationLive) return true;
    if (needsTitle && !titleLive) return true;
  }
  return preferencesGateIncomplete(snap, fillResult);
}
