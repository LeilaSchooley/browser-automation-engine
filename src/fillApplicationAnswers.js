/**
 * Application screening answers (visa, work auth, remote, relocate, EEOC) —
 * separate from job-search preferences. Detectors live in patterns/applicationScreening.js.
 */

import { COMPANY_NO_MAPPED } from "./primitives/controlPatterns.js";
import {
  SCREENING_MAPPED,
  REMOTE_ANSWER_BY_PREF,
  normalizeRemotePreference,
  looksLikePolicyAck,
  looksLikeSponsorship,
  looksLikeWorkAuth,
  looksLikeRemote,
  looksLikeRelocate,
  looksLikeHideFromCompanies,
  getHideFromCompaniesValue,
  HIDE_FROM_COMPANIES_PROMPT_RULE,
} from "./patterns/applicationScreening.js";

export const EEOC_MAPPED = new Set(["eeocgender", "eeocrace", "eeocveteran", "eeocdisability"]);
export const APPLICATION_CONTROL_MAPPED = new Set([
  ...SCREENING_MAPPED,
  "pronouns",
  ...COMPANY_NO_MAPPED,
  ...EEOC_MAPPED,
]);

function truthy(val, defaultVal = false) {
  if (val === undefined || val === null || val === "") return defaultVal;
  return val === true || ["1", "true", "yes", "on"].includes(String(val).toLowerCase());
}

export function getApplicationAnswers(context = {}) {
  const p = context.preferences || {};
  const a = context.applicant || context.profile || {};
  const rawVisa = p.needsVisaSponsorship ?? a.needsVisaSponsorship ?? false;
  const needsVisa = truthy(rawVisa, false);
  const eeocDecline = p.eeocDecline !== false && a.eeocDecline !== false;
  // Legally authorized to work — independent of sponsorship. Default Yes.
  const workAuthorized =
    p.workAuthorized !== undefined || a.workAuthorized !== undefined
      ? truthy(p.workAuthorized ?? a.workAuthorized, true)
      : true;
  const pronouns = String(p.pronouns || a.pronouns || process.env.YOUR_PRONOUNS || "He/him").trim();
  const remotePreference = normalizeRemotePreference(p.remotePreference ?? a.remotePreference);
  const willingToRelocate = truthy(p.willingToRelocate ?? a.willingToRelocate, false);
  const hideFromCompanies = getHideFromCompaniesValue(context);

  return {
    needsVisaSponsorship: needsVisa,
    visaAnswer: needsVisa ? "Yes" : "No",
    workAuthorized,
    workAuthorizationAnswer: workAuthorized ? "Yes" : "No",
    remotePreference,
    remoteAnswer: REMOTE_ANSWER_BY_PREF[remotePreference],
    willingToRelocate,
    relocateAnswer: willingToRelocate ? "Yes" : "No",
    hideFromCompanies,
    eeocDecline,
    eeocDeclineAnswer: "Decline to self-identify",
    pronouns: pronouns || "Use name only",
  };
}

/** Resolve visa / work-auth / remote / EEOC answers from context preferences. */
export function resolveApplicationAnswer(mappedTo, label, context) {
  const m = String(mappedTo || "").toLowerCase();
  const blob = `${label || ""} ${m}`.toLowerCase();
  const answers = getApplicationAnswers(context);

  // Policy acknowledgments first (contain "sponsor" but expect Yes).
  if (m === "policyack" || looksLikePolicyAck(blob)) {
    return "Yes";
  }
  if (m === "workauthorization" || (looksLikeWorkAuth(blob) && !looksLikeSponsorship(blob) && !looksLikePolicyAck(blob))) {
    return answers.workAuthorizationAnswer;
  }
  if (m === "visasponsorship" || looksLikeSponsorship(blob)) {
    return answers.visaAnswer;
  }
  if (m === "remotepreference" || looksLikeRemote(blob)) {
    return answers.remoteAnswer;
  }
  if (m === "willingtorelocate" || looksLikeRelocate(blob)) {
    return answers.relocateAnswer;
  }
  if (m === "hidecompanies" || looksLikeHideFromCompanies(blob)) {
    return answers.hideFromCompanies || "";
  }
  // Employer affiliation (current/former employee, volunteer, contractor, relation) → No.
  if (COMPANY_NO_MAPPED.has(m) || looksLikeCompanyAffiliation(blob)) {
    return "No";
  }
  if (EEOC_MAPPED.has(m) || /\bgender\b|\brace\b|ethnic|veteran|disabilit/.test(blob)) {
    if (answers.eeocDecline) return answers.eeocDeclineAnswer;
  }
  if (m === "pronouns" || /\bpronouns?\b/.test(blob)) {
    return answers.pronouns;
  }
  return "";
}

function looksLikeCompanyAffiliation(blob) {
  return (
    /related to an employee|related to .{0,40}\bemployee\b/.test(blob) ||
    /\bcurrent or former employee\b|\bformer employee of\b|are you (a |an )?(current|former)\s+employee\b/.test(blob) ||
    /been in your position for at least|at least one year/.test(blob) ||
    /\bvolunteer\b/.test(blob) ||
    /\bcontractor\b|third[\s-]party/.test(blob)
  );
}

function controlLooksApplicationMapped(c) {
  if (!c) return false;
  const mapped = String(c.mappedTo || c.type || "").toLowerCase();
  if (APPLICATION_CONTROL_MAPPED.has(mapped)) return true;
  if (c.widgetType === "yesno") return true;
  if (c.widgetType === "radio" && (EEOC_MAPPED.has(mapped) || COMPANY_NO_MAPPED.has(mapped) || SCREENING_MAPPED.has(mapped))) {
    return true;
  }
  if (c.widgetType === "select" && APPLICATION_CONTROL_MAPPED.has(mapped)) return true;
  if (c.widgetType === "checkbox" && mapped === "pronouns") return true;
  if (c.widgetType === "text" && (COMPANY_NO_MAPPED.has(mapped) || mapped === "hidecompanies")) return true;
  return false;
}

/** Unfilled yes/no, work-auth, or EEOC controls on the current snap. */
export function hasUnfilledYesNoOrEEOC(snap) {
  if (!snap) return false;
  return (snap.customControls || []).some((c) => !c.filled && controlLooksApplicationMapped(c));
}

/** Broader leftover pass: any unfilled application-mapped control (incl. selects). */
export function hasUnfilledApplicationControls(snap) {
  return hasUnfilledYesNoOrEEOC(snap);
}

/** One-shot Stagehand instruction for screening / EEOC when deterministic fill missed. */
export function buildApplicationControlsStagehandInstruction(context = {}) {
  const answers = getApplicationAnswers(context);
  const parts = [];
  if (answers.workAuthorizationAnswer) {
    parts.push(
      `For "legally authorized to work" / work authorization questions, click ${answers.workAuthorizationAnswer}`,
    );
  }
  if (answers.visaAnswer) {
    parts.push(`For visa sponsorship questions, click ${answers.visaAnswer}`);
  }
  if (answers.remoteAnswer) {
    parts.push(`For "open to working remotely" questions, select "${answers.remoteAnswer}"`);
  }
  if (answers.relocateAnswer) {
    parts.push(`For "willing to relocate" questions, click ${answers.relocateAnswer}`);
  }
  parts.push(
    'For "Do you understand… unable to sponsor" / policy acknowledgment questions, click Yes',
  );
  if (answers.eeocDecline) {
    parts.push(
      `For voluntary Gender, Race, Veteran status, and Disability questions, select "${answers.eeocDeclineAnswer}" (or "I do not want to answer" / "Prefer not to say" if shown)`,
    );
  }
  if (answers.pronouns) {
    parts.push(`For Pronouns checkboxes, select "${answers.pronouns}" (or "Use name only" if that option exists)`);
  }
  parts.push(
    'For "current or former employee", volunteer, contractor, and "related to an employee" questions, answer No (external applicant)',
  );
  if (answers.hideFromCompanies) {
    parts.push(`For hide-from-employer / companies-hidden-from fields, enter "${answers.hideFromCompanies}"`);
  } else {
    parts.push(HIDE_FROM_COMPANIES_PROMPT_RULE);
  }
  parts.push("Complete every remaining required (*) radio and text field you can");
  parts.push("Do not click Submit Application yet");
  return `${parts.join(". ")}.`;
}
