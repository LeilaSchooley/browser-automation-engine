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

/** Follow-up typeahead when relocate = Yes (YC: “Where else would you relocate?”). */
export const RELOCATE_LOCATIONS_RE =
  /where else (would you )?relocat|relocat(e|ion).{0,60}(cities|regions|countries)|cities.{0,30}relocat|open to relocating to/i;

/** Yes/No relocate willingness — must not match relocate-cities typeaheads. */
export const WILLING_TO_RELOCATE_RE =
  /willing to relocate|open to relocati(?!ng to)|are you.{0,20}willing.{0,20}relocat/i;

/** Employer hide-list / block-from-seeing-profile fields (any board). */
export const HIDE_FROM_COMPANIES_RE =
  /hidden from|hide (me |my |this )?(profile )?from|companies you want to be hidden|compan(y|ies).{0,40}hidden|block(ed)? (me from )?compan|do not (show|share|visible).{0,40}(employer|compan)|current employer.{0,20}hidden/i;

/** WaaS / profile wizard: primary job function picker. */
export const JOB_FUNCTION_RE =
  /job function|what job function|function best fits|looking for\??\s*$/i;

/** Internship vs full-time after graduation. */
export const ROLE_INTEREST_RE =
  /kind of role you interested|what kind of role|role you interested in/i;

/** Full-time student at school/bootcamp. */
export const FULL_TIME_STUDENT_RE =
  /full-time student|are you a (full[- ]time )?student|school or bootcamp/i;

/**
 * Employment-type multi-select (WaaS job_type): "Full-time employee /
 * Contractor / Cofounder". Distinct from ROLE_INTEREST ("what kind of role you
 * interested in") and JOB_FUNCTION ("job function"). Matches the question copy
 * or the tell-tale option set so a bare "Contractor" option never leaks into the
 * affiliation yes/no.
 */
export const EMPLOYMENT_TYPE_RE =
  /what job type\(s\)|job type\(s\).{0,40}interested|type of role you.{0,20}looking for|what type of (role|employment|work)|employment type|which type of (role|employment)|full[- ]?time employee.{0,60}(contractor|co[- ]?founder)|are you looking for a (full[- ]?time|contract)/i;

/** WaaS engineering sub-roles multi-select (eng_type), shown after job function = Engineering. */
export const ENG_ROLES_RE =
  /engineering roles are you most interested|which engineering roles|choose up to four/i;

/** WaaS /application/skills — technologies multi-select (not eng_type). */
export const TECH_SKILLS_RE =
  /technologies\/?skills|which technologies|skills are you most|technologies.?skills are you|tech(?:nology)? stack|programming languages you/i;

/** Soft label matchers for custom-control fill (Playwright). */
export const REMOTE_PREFERENCE_LABEL_RE = /open to working remotely|work remotely/i;
export const WILLING_TO_RELOCATE_LABEL_RE = /willing to relocate|relocat/i;
export const JOB_FUNCTION_LABEL_RE = /job function|function best fits/i;
export const ROLE_INTEREST_LABEL_RE = /kind of role|role you interested|internship|full-time role/i;
export const FULL_TIME_STUDENT_LABEL_RE = /full-time student|school or bootcamp/i;
export const EMPLOYMENT_TYPE_LABEL_RE =
  /what job type\(s\)|job type\(s\)|type of (role|employment|work)|employment type|full[- ]?time employee|contractor|co[- ]?founder/i;
export const ENG_ROLES_LABEL_RE =
  /engineering roles are you most interested|which engineering roles|choose up to four/i;
export const TECH_SKILLS_LABEL_RE =
  /technologies\/?skills|which technologies|skills are you most|tech(?:nology)? stack|programming languages/i;
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
  // Role-step (WaaS profile wizard) — after relocate so "relocate" copy doesn't steal.
  { re: FULL_TIME_STUDENT_RE, mappedTo: "fulltimestudent", type: "fulltimestudent" },
  { re: EMPLOYMENT_TYPE_RE, mappedTo: "employmenttype", type: "employmenttype" },
  { re: JOB_FUNCTION_RE, mappedTo: "jobfunction", type: "jobfunction" },
  { re: ENG_ROLES_RE, mappedTo: "engroles", type: "engroles" },
  { re: TECH_SKILLS_RE, mappedTo: "techskills", type: "techskills" },
  { re: ROLE_INTEREST_RE, mappedTo: "roleinterest", type: "roleinterest" },
];

export const SCREENING_MAPPED = new Set(SCREENING_LABEL_TO_MAPPED.map((e) => e.mappedTo));

/**
 * Infer a WaaS-style job-function option label from desired title / prefs.
 * @param {string} title
 * @param {string} [explicit]
 */
export function resolveJobFunctionAnswer(title = "", explicit = "") {
  const forced = String(explicit || "").trim();
  if (forced) return forced;
  const t = String(title || "").toLowerCase();
  if (/design|ui\/?ux|illustrat|brand/.test(t)) return "Design";
  if (/\bproduct\b/.test(t) && !/engineer|eng\b|software|backend|frontend|fullstack/.test(t)) return "Product";
  if (/market|growth|seo|content/.test(t)) return "Marketing";
  if (/recruit|talent|hr\b|human resources/.test(t)) return "Recruiting";
  if (/ops|operations/.test(t)) return "Operations";
  if (/financ|account/.test(t)) return "Finance";
  if (/legal|counsel|attorney/.test(t)) return "Legal";
  if (/sales|account exec/.test(t)) return "Sales";
  if (/support|customer success|customer service/.test(t)) return "Support";
  if (/scien|biolog|chem|lab\b/.test(t)) return "Science";
  // Default for engineering titles (Founding Product Engineer → Engineering).
  if (/engineer|eng\b|software|developer|sre|devops|ml\b|data\b|hardware|fullstack|frontend|backend/.test(t)) {
    return "Engineering";
  }
  return "Engineering";
}

/** WaaS `name="role"` radio value for a resolved job-function label. */
export function resolveJobFunctionRadioValue(title = "", explicit = "") {
  const label = resolveJobFunctionAnswer(title, explicit);
  const map = {
    Engineering: "eng",
    Design: "design",
    Product: "product",
    Science: "science",
    Sales: "sales",
    Marketing: "marketing",
    Support: "support",
    Recruiting: "recruiting",
    Operations: "operations",
    Finance: "finance",
    Legal: "legal",
  };
  return map[label] || "eng";
}

/** Up to four WaaS engineering sub-role labels inferred from desired title. */
export function resolveEngRolesFromTitle(title = "", explicit = null) {
  if (explicit != null && explicit !== "") {
    const list = Array.isArray(explicit) ? explicit : [explicit];
    return [...new Set(list.map((s) => String(s || "").trim()).filter(Boolean))].slice(0, 4);
  }
  const t = String(title || "").toLowerCase();
  const roles = [];
  if (/full.?stack|founding|product engineer|software engineer|developer/.test(t)) roles.push("Full stack");
  if (/backend|back.?end|\bapi\b/.test(t)) roles.push("Backend");
  if (/frontend|front.?end|ui engineer/.test(t)) roles.push("Frontend");
  if (/\bml\b|machine learning|\bai\b/.test(t)) roles.push("Machine learning");
  if (/data sci|data engineer/.test(t)) roles.push("Data science");
  if (/devops|sre|infra/.test(t)) roles.push("Devops");
  if (/embedded|firmware|hardware/.test(t)) roles.push("Embedded systems");
  if (!roles.length) roles.push("Full stack");
  return [...new Set(roles)].slice(0, 4);
}

/**
 * Tech skills for WaaS /application/skills multi-select.
 * Prefer explicit profile skills; otherwise infer a short stack from the job title.
 * @param {string|string[]|null} [explicit]
 * @param {string} [title]
 */
export function resolveTechSkills(explicit = null, title = "") {
  const fromExplicit = (() => {
    if (explicit == null || explicit === "") return [];
    const list = Array.isArray(explicit)
      ? explicit
      : String(explicit)
          .split(/[,;|]/)
          .map((s) => s.trim())
          .filter(Boolean);
    return [...new Set(list.map((s) => String(s || "").trim()).filter(Boolean))];
  })();
  if (fromExplicit.length) return fromExplicit.slice(0, 8);

  const t = String(title || "").toLowerCase();
  const skills = [];
  if (/typescript|ts\b|react|node|javascript|full.?stack|product engineer|software|founding/.test(t)) {
    skills.push("TypeScript", "React", "Node.js");
  }
  if (/python|\bai\b|\bml\b|agent|llm|data/.test(t)) skills.push("Python");
  if (/postgres|sql|backend|data/.test(t)) skills.push("PostgreSQL");
  if (/aws|cloud|devops|sre/.test(t)) skills.push("AWS");
  if (!skills.length) skills.push("JavaScript", "TypeScript", "React", "Node.js");
  return [...new Set(skills)].slice(0, 8);
}

export function resolveRoleInterestAnswer(raw = "") {
  const key = String(raw || "fulltime").toLowerCase().trim();
  if (/intern/.test(key)) return "An internship (e.g. during the summer)";
  return "A full-time role after graduation";
}

/**
 * Employment-type option to select (WaaS job_type multi-select). Defaults to a
 * standard full-time employee; honors an explicit preference like "contractor".
 * @param {string} [raw]
 */
export function resolveEmploymentTypeAnswer(raw = "") {
  const key = String(raw || "").toLowerCase().trim();
  if (/contract/.test(key)) return "Contractor";
  if (/co[- ]?found/.test(key)) return "Cofounder";
  if (/part[- ]?time/.test(key)) return "Part-time employee";
  return "Full-time employee";
}

export function looksLikeJobFunction(blob) {
  return JOB_FUNCTION_RE.test(String(blob || ""));
}

export function looksLikeRoleInterest(blob) {
  return ROLE_INTEREST_RE.test(String(blob || ""));
}

export function looksLikeFullTimeStudent(blob) {
  return FULL_TIME_STUDENT_RE.test(String(blob || ""));
}

export function looksLikeEmploymentType(blob) {
  return EMPLOYMENT_TYPE_RE.test(String(blob || ""));
}

export function looksLikeEngRoles(blob) {
  return ENG_ROLES_RE.test(String(blob || ""));
}

export function looksLikeTechSkills(blob) {
  return TECH_SKILLS_RE.test(String(blob || ""));
}

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
  const s = String(blob || "");
  if (RELOCATE_LOCATIONS_RE.test(s)) return false;
  return WILLING_TO_RELOCATE_RE.test(s);
}

export function looksLikeRelocateLocations(blob) {
  return RELOCATE_LOCATIONS_RE.test(String(blob || ""));
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
