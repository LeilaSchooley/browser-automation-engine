/**
 * Site-agnostic application screening patterns (work auth, visa, remote, relocate,
 * hide-from-employer, policy ack). ATS boards (Greenhouse, Lever, Ashby, WaaS, etc.)
 * share these question shapes — keep detectors here, not in host-specific code.
 */

/** Policy acknowledgments that mention "sponsor" but expect Yes. */
export const POLICY_ACK_RE =
  /do you understand|unable to sponsor|acknowledge|confirm that you (understand|agree)|agree that applicants must be authorized/i;

/** Future sponsorship need — not the "unable to sponsor" policy ack. */
export const VISA_SPONSORSHIP_RE =
  /will you (now|in the future).*sponsor|require\s+(visa\s+)?sponsorship|require.*(immigrat|sponsor)|need.*sponsor|sponsorship for an employment|visa sponsorship|H-1B/i;

export const WORK_AUTH_RE =
  /legally\s*authorized|authorized\s*to\s*work|work\s*authorization|eligible\s*to\s*work|right\s*to\s*work|authorized to work for any employer/i;

export const REMOTE_PREFERENCE_RE =
  /open to working remotely|work remotely|remote work preference|only want to work remotely/i;

export const WILLING_TO_RELOCATE_RE = /willing to relocate|open to relocati|relocat(e|ion)\b/i;

/** Employer hide-list / block-from-seeing-profile fields (any board). */
export const HIDE_FROM_COMPANIES_RE =
  /hidden from|hide (me |my |this )?(profile )?from|companies you want to be hidden|compan(y|ies).{0,40}hidden|block(ed)? (me from )?compan|do not (show|share|visible).{0,40}(employer|compan)|current employer.{0,20}hidden/i;

/** Soft label matchers for custom-control fill (Playwright). */
export const REMOTE_PREFERENCE_LABEL_RE = /open to working remotely|work remotely/i;
export const WILLING_TO_RELOCATE_LABEL_RE = /willing to relocate|relocat/i;
export const VISA_SELECT_NAME_RE = /visa|sponsor/i;
export const WORK_AUTH_SELECT_NAME_RE = /authoriz|work.?auth|eligible/i;
export const REMOTE_SELECT_NAME_RE = /remote/i;
export const RELOCATE_SELECT_NAME_RE = /relocat/i;

/** smart_fill FIELD_TYPE keyword lists (string form for in-page eval sync tests). */
export const HIDE_COMPANIES_FIELD_KEYWORDS = [
  "hidden from",
  "companies you want to be hidden",
  "hide my profile",
  "hide from",
  "current employer",
];

export const HIDE_COMPANIES_ANTI_KEYWORDS = ["first name", "last name", "email", "phone", "linkedin"];

/** Fullname / companyname must not steal hide-list fields. */
export const HIDE_COMPANIES_IDENTITY_ANTI_KEYWORDS = [
  "companies",
  "hidden from",
  "hidden",
  "hide my",
  "hide from",
];

/**
 * Preference key → option text commonly used on ATS remote radios.
 * Hosts map settings like `no` | `open` | `only` into these phrases.
 */
export const REMOTE_ANSWER_BY_PREF = {
  no: "I don't want to work remotely",
  open: "I'm open to working remotely",
  only: "I only want to work remotely",
};

/** Label → mappedTo entries for screening questions (order matters: policy before visa). */
export const SCREENING_LABEL_TO_MAPPED = [
  { re: POLICY_ACK_RE, mappedTo: "policyack", type: "policyack" },
  { re: VISA_SPONSORSHIP_RE, mappedTo: "visasponsorship", type: "visasponsorship" },
  { re: WORK_AUTH_RE, mappedTo: "workauthorization", type: "workauthorization" },
  { re: REMOTE_PREFERENCE_RE, mappedTo: "remotepreference", type: "remotepreference" },
  { re: WILLING_TO_RELOCATE_RE, mappedTo: "willingtorelocate", type: "willingtorelocate" },
  { re: HIDE_FROM_COMPANIES_RE, mappedTo: "hidecompanies", type: "hidecompanies" },
];

export const SCREENING_MAPPED = new Set(SCREENING_LABEL_TO_MAPPED.map((e) => e.mappedTo));

export function looksLikePolicyAck(blob) {
  return POLICY_ACK_RE.test(String(blob || ""));
}

export function looksLikeSponsorship(blob) {
  return VISA_SPONSORSHIP_RE.test(String(blob || ""));
}

export function looksLikeWorkAuth(blob) {
  return WORK_AUTH_RE.test(String(blob || ""));
}

export function looksLikeRemote(blob) {
  return REMOTE_PREFERENCE_RE.test(String(blob || ""));
}

export function looksLikeRelocate(blob) {
  return WILLING_TO_RELOCATE_RE.test(String(blob || ""));
}

export function looksLikeHideFromCompanies(blob) {
  return HIDE_FROM_COMPANIES_RE.test(String(blob || ""));
}

/** Normalize remote preference key from settings / preferences. */
export function normalizeRemotePreference(raw) {
  const key = String(raw ?? "open").toLowerCase().trim();
  return REMOTE_ANSWER_BY_PREF[key] ? key : "open";
}

export function remoteAnswerForPreference(raw) {
  return REMOTE_ANSWER_BY_PREF[normalizeRemotePreference(raw)];
}

/** Read hide-from-employer value from applicant / preferences context. */
export function getHideFromCompaniesValue(context = {}) {
  const p = context.preferences || {};
  const a = context.applicant || context.profile || {};
  return String(p.hideFromCompanies ?? a.hideFromCompanies ?? "").trim();
}

/** Prompt fragment for LLM / Stagehand — never invent personal names into hide-lists. */
export const HIDE_FROM_COMPANIES_PROMPT_RULE =
  'For "companies you want to be hidden from" / hide-profile-from-employer fields: use hideFromCompanies from settings only if set; otherwise leave blank — never enter the applicant personal name';
