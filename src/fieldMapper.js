/**
 * Omni field mapper — job-application relevance + fill order.
 *
 * Design (anti-naive):
 * - Do NOT require a keyword allowlist (that drops real custom ATS questions).
 * - REJECT noise chrome: footer / nav / newsletter / cookie / site-search.
 * - KEEP unknown fields inside apply surfaces (cards[], eeo[], application-form).
 * - Order: truly required → soft identity → optional → voluntary EEOC.
 */

/** Logical fill bands (lower = earlier). Unknown types fall back to visual. */
export const LOGICAL_TYPE_BAND = {
  name: 10,
  fullname: 10,
  chosenname: 10,
  preferredname: 10,
  firstname: 11,
  lastname: 12,
  pronouns: 15,
  email: 20,
  tel: 25,
  phone: 25,
  mobile: 25,
  address: 30,
  address1: 30,
  address2: 31,
  street: 30,
  city: 32,
  state: 33,
  zip: 34,
  postal: 34,
  citystatezip: 34,
  country: 35,
  location: 36,
  company: 38,
  currentcompany: 38,
  desiredtitle: 40,
  linkedin: 45,
  linkedinurl: 45,
  website: 46,
  salary: 55,
  formeremployee: 56,
  employeetenure: 56,
  volunteer: 56,
  contractor: 56,
  employeerelation: 57,
  workauthorization: 58,
  visasponsorship: 60,
  policyack: 60,
  eeocgender: 61,
  eeocrace: 62,
  eeocveteran: 63,
  eeocdisability: 64,
  gender: 61,
  race: 62,
  veteran: 63,
  disability: 64,
  resume: 70,
  coverletter: 80,
  additionalinfo: 90,
};

export const REQUIRED_MARK_RE = /\*|✱|required|mandatory|\bmust\b/i;

/** Identity / early-form questions we prioritize even without an asterisk. */
const PRIORITY_IDENTITY_RE =
  /\b(chosen\s*name|preferred\s*name|full\s*name|legal\s*name|first\s*name|last\s*name|\bpronouns?\b)\b/i;

/** Employer affiliation cards (Trevor-style) — usually required for external applicants. */
export const COMPANY_AFFILIATION_RE =
  /\bcurrent or former employee\b|\bformer employee of\b|are you (a |an )?(current|former)\s+employee\b|\bvolunteer\b|\bcontractor\b|third[\s-]party|related to an employee|been in your position for at least/i;

/** Voluntary EEOC / diversity self-ID — fill after required application fields. */
export const VOLUNTARY_FIELD_RE =
  /\bvoluntary\b|\boptional\b|self[- ]?identify|decline to self-identify|equal employment|eeo(?:c)?\b|diversity (?:survey|information)|protected veteran|disability status|confidential/i;

const EEOC_TYPE_SET = new Set([
  "eeocgender",
  "eeocrace",
  "eeocveteran",
  "eeocdisability",
  "gender",
  "race",
  "veteran",
  "disability",
]);

const COMPANY_TYPE_SET = new Set([
  "formeremployee",
  "employeetenure",
  "volunteer",
  "contractor",
  "employeerelation",
]);

const IDENTITY_TYPE_SET = new Set([
  "fullname",
  "firstname",
  "lastname",
  "chosenname",
  "preferredname",
  "email",
  "tel",
  "phone",
  "address",
  "address1",
  "address2",
  "city",
  "state",
  "zip",
  "postal",
  "citystatezip",
  "pronouns",
]);

const NOISE_ANCESTRY_RE =
  /footer|contentinfo|newsletter|subscribe|mailing.?list|cookie|onetrust|gdpr|preference.?center|site.?search|global.?search/i;

const APPLY_SURFACE_RE =
  /application-form|application-question|apply-form|ashby-application|greenhouse|lever-?application|additional-cards|eeo-survey|candidat|job.?application|posting-|woocommerce|wpforms/i;

const APPLY_NAME_RE =
  /^(name|email|phone|tel|resume|cover|cards?\[|eeo\[|urls?\[|pronoun|location|selectedLocation|linkedin)/i;

const APPLY_CLUE_RE =
  /\b(name|email|phone|tel|mobile|address|street|city|zip|postal|linkedin|website|resume|cv|cover.?letter|pronoun|gender|race|ethnic|veteran|disabilit|visa|sponsor|authorized|location|salary|compensation|how did you hear|years? of experience|chosen)\b/i;

function fieldBlob(field) {
  return `${field?.label || ""} ${field?.clue || ""} ${field?.questionLabel || ""} ${field?.placeholder || ""} ${field?.name || ""} ${field?.selector || ""}`;
}

function pageContextBlob(ctx = {}) {
  return `${ctx.pageText || ""} ${ctx.headings || ""} ${ctx.body || ""} ${ctx.pageBody || ""}`;
}

export function isNoiseApplicationField(field, ctx = {}) {
  if (!field) return true;
  if (field.inFooter || field.inNav) return true;

  const sel = String(field.selector || "");
  const blob = `${field.clue || ""} ${field.label || ""} ${field.name || ""} ${sel}`.toLowerCase();

  if (/footer|\[role=.?contentinfo|newsletter|subscribe|#onetrust|cookie-banner/i.test(sel)) {
    if (!APPLY_SURFACE_RE.test(sel)) return true;
  }
  if (/nav\[|header\s*>/i.test(sel) && !APPLY_SURFACE_RE.test(sel) && !APPLY_NAME_RE.test(field.name || "")) {
    return true;
  }
  if (NOISE_ANCESTRY_RE.test(blob) && !APPLY_SURFACE_RE.test(blob) && !APPLY_NAME_RE.test(field.name || "")) {
    if (!field.required || /newsletter|subscribe|footer/i.test(blob)) return true;
  }
  if (/newsletter|subscribe|footer/i.test(blob) && /email|phone/i.test(blob) && !APPLY_SURFACE_RE.test(blob)) {
    return true;
  }
  if (/\bsearch\b|\bquery\b/.test(blob) && !APPLY_CLUE_RE.test(blob)) return true;

  if (ctx.pageKind === "login" && /password|username|sign.?in/i.test(blob)) return true;

  return false;
}

export function isJobApplicationField(field, ctx = {}) {
  if (!field) return false;
  if (isNoiseApplicationField(field, ctx)) return false;

  const sel = String(field.selector || "");
  const name = String(field.name || "");
  const blob = `${field.clue || ""} ${field.label || ""} ${name} ${sel}`;

  if (APPLY_NAME_RE.test(name)) return true;
  if (APPLY_SURFACE_RE.test(sel) || APPLY_SURFACE_RE.test(blob)) return true;
  if (field.inApplyModal || field.inMainContent) return true;
  if (field.required) return true;
  if (field.type && LOGICAL_TYPE_BAND[field.type] != null) return true;
  if (field.mappedTo && LOGICAL_TYPE_BAND[field.mappedTo] != null) return true;
  if (APPLY_CLUE_RE.test(blob)) return true;

  if (ctx.looksLikeApplyForm && (field.clue || field.label) && !isNoiseApplicationField(field, ctx)) {
    return true;
  }

  return false;
}

/** Voluntary EEOC / diversity self-ID — deprioritize vs required cards. */
export function isVoluntaryField(field, ctx = {}) {
  if (!field) return false;
  const t = String(field.type || field.mappedTo || "").toLowerCase();
  const blob = fieldBlob(field).toLowerCase();
  const page = pageContextBlob(ctx).toLowerCase();

  if (COMPANY_TYPE_SET.has(t) || COMPANY_AFFILIATION_RE.test(blob)) return false;
  if (/\beeo\[/i.test(String(field.name || "")) || /\beeo\[/i.test(String(field.selector || ""))) {
    return true;
  }
  if (EEOC_TYPE_SET.has(t)) return true;
  if (VOLUNTARY_FIELD_RE.test(blob)) return true;
  if (
    /\b(gender|race|ethnic|veteran|disabilit)\b/i.test(blob) &&
    (VOLUNTARY_FIELD_RE.test(page) || /equal employment|u\.?s\.?\s*equal/i.test(page))
  ) {
    return true;
  }
  return false;
}

/**
 * Strong required detection: asterisk / HTML required / company affiliation cards.
 * Voluntary EEOC never counts as truly required (even if nearby headings say "must").
 */
export function isTrulyRequired(field, ctx = {}) {
  if (!field) return false;
  if (isVoluntaryField(field, ctx)) return false;

  const t = String(field.type || field.mappedTo || "").toLowerCase();
  const blob = fieldBlob(field);

  if (COMPANY_TYPE_SET.has(t) || COMPANY_AFFILIATION_RE.test(blob)) return true;
  if (field.required || field.isRequired || field.ariaRequired) return true;
  if (REQUIRED_MARK_RE.test(blob)) return true;
  if (["workauthorization", "visasponsorship", "policyack", "salary"].includes(t) && REQUIRED_MARK_RE.test(blob)) {
    return true;
  }
  return false;
}

export function looksRequiredField(field, ctx = {}) {
  if (!field) return false;
  if (isVoluntaryField(field, ctx)) return false;
  if (isTrulyRequired(field, ctx)) return true;
  const blob = fieldBlob(field);
  if (PRIORITY_IDENTITY_RE.test(blob)) return true;
  const t = String(field.type || field.mappedTo || "").toLowerCase();
  if (IDENTITY_TYPE_SET.has(t)) return true;
  return false;
}

export function logicalBand(field) {
  const key = String(field?.type || field?.mappedTo || "").toLowerCase();
  if (key && LOGICAL_TYPE_BAND[key] != null) return LOGICAL_TYPE_BAND[key];
  const blob = `${field?.label || ""} ${field?.clue || ""} ${field?.name || ""}`.toLowerCase();
  if (/chosen\s*name|preferred\s*name/.test(blob)) return LOGICAL_TYPE_BAND.chosenname;
  if (/\bpronouns?\b/.test(blob)) return LOGICAL_TYPE_BAND.pronouns;
  for (const [k, band] of Object.entries(LOGICAL_TYPE_BAND)) {
    if (k.length >= 3 && blob.includes(k)) return band;
  }
  return 50;
}

function compareVisualPos(a, b) {
  const ay = Number(a?.top ?? a?.y ?? 1e9);
  const by = Number(b?.top ?? b?.y ?? 1e9);
  if (ay !== by) return ay - by;
  return Number(a?.left ?? a?.x ?? 0) - Number(b?.left ?? b?.x ?? 0);
}

/**
 * Rank: 0 identity/true-required → 1 soft-required → 2 optional → 3 voluntary EEOC.
 */
export function requiredPriorityRank(field, ctx = {}) {
  if (!field) return 2;
  if (isVoluntaryField(field, ctx)) return 3;

  const t = String(field.type || field.mappedTo || "").toLowerCase();
  if (IDENTITY_TYPE_SET.has(t)) return 0;
  const blob = fieldBlob(field);
  if (PRIORITY_IDENTITY_RE.test(blob)) return 0;
  if (isTrulyRequired(field, ctx)) return 0;
  if (looksRequiredField(field, ctx)) return 1;
  return 2;
}

/**
 * Required first → logical band → visual.
 * @param {object} a
 * @param {object} b
 * @param {object} [ctx]
 */
export function compareApplyFillOrder(a, b, ctx = {}) {
  const ar = requiredPriorityRank(a, ctx);
  const br = requiredPriorityRank(b, ctx);
  if (ar !== br) return ar - br;

  const bandA = logicalBand(a);
  const bandB = logicalBand(b);
  const typedA = Boolean(a?.type || a?.mappedTo);
  const typedB = Boolean(b?.type || b?.mappedTo);
  if (typedA && typedB && bandA !== bandB) return bandA - bandB;
  if (bandA !== bandB) return bandA - bandB;

  return compareVisualPos(a, b);
}

export function sortApplyFields(fields, ctx = {}) {
  const list = Array.isArray(fields) ? fields : [];
  const filtered = list.filter((f) => isJobApplicationField(f, ctx));
  return [...filtered].sort((a, b) => compareApplyFillOrder(a, b, ctx));
}

/** Alias — sort with page context (pageText / headings) for voluntary detection. */
export function sortFieldsIntelligently(fields, pageContext = {}) {
  return sortApplyFields(fields, {
    looksLikeApplyForm: true,
    ...pageContext,
  });
}

export function detectRequiredUnfilled(fields, ctx = {}) {
  return (fields || []).filter(
    (f) => looksRequiredField(f, ctx) && !f.filled && !f.hasValue && !isVoluntaryField(f, ctx),
  );
}

export function buildRequiredFieldsInstruction(fields, ctx = {}) {
  const req = detectRequiredUnfilled(fields, ctx).slice(0, 12);
  if (!req.length) return "";
  const labels = req
    .map((f) => f.label || f.clue || f.name || f.mappedTo || f.type || "field")
    .map((s) => String(s).replace(/\s+/g, " ").trim().slice(0, 60))
    .filter(Boolean);
  return (
    `Fill these REQUIRED job-application fields in order (skip footer/nav/newsletter): ` +
    `${labels.join(" → ")}. ` +
    `For employee/volunteer/contractor/related-to-employee questions prefer No. ` +
    `Defer voluntary EEOC / self-identify until after required fields. ` +
    `Use He/him for pronouns when shown. Do not submit.`
  );
}

/** True when a custom control should run in the early smart_fill pass (not voluntary EEOC). */
export function isEarlyCustomControl(control, ctx = {}) {
  if (!control || control.filled) return false;
  if (isVoluntaryField(control, ctx)) return false;
  const t = String(control.mappedTo || control.type || "").toLowerCase();
  if (COMPANY_TYPE_SET.has(t) || IDENTITY_TYPE_SET.has(t)) return true;
  if (["visasponsorship", "workauthorization", "policyack", "pronouns", "salary"].includes(t)) return true;
  if (["yesno", "checkbox", "radio"].includes(String(control.widgetType || "")) && !EEOC_TYPE_SET.has(t)) {
    return true;
  }
  return false;
}
