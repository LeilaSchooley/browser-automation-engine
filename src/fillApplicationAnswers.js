/**
 * Application-specific answers (visa, work auth, EEOC) — separate from job-search preferences.
 */

export const EEOC_MAPPED = new Set(["eeocgender", "eeocrace", "eeocveteran", "eeocdisability"]);
export const APPLICATION_CONTROL_MAPPED = new Set([
  "visasponsorship",
  "workauthorization",
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

  return {
    needsVisaSponsorship: needsVisa,
    visaAnswer: needsVisa ? "Yes" : "No",
    workAuthorized,
    workAuthorizationAnswer: workAuthorized ? "Yes" : "No",
    eeocDecline,
    eeocDeclineAnswer: "Decline to self-identify",
  };
}

function looksLikeWorkAuth(blob) {
  return /legally\s*authorized|authorized\s*to\s*work|work\s*authorization|eligible\s*to\s*work|right\s*to\s*work/.test(
    blob,
  );
}

function looksLikeSponsorship(blob) {
  return /visa|sponsor|sponsorship|require.*sponsor|will you.*sponsor/.test(blob);
}

/** Resolve visa / work-auth / EEOC answers from context preferences. */
export function resolveApplicationAnswer(mappedTo, label, context) {
  const m = String(mappedTo || "").toLowerCase();
  const blob = `${label || ""} ${m}`.toLowerCase();
  const answers = getApplicationAnswers(context);

  if (m === "workauthorization" || (looksLikeWorkAuth(blob) && !looksLikeSponsorship(blob))) {
    return answers.workAuthorizationAnswer;
  }
  if (m === "visasponsorship" || looksLikeSponsorship(blob)) {
    return answers.visaAnswer;
  }
  if (EEOC_MAPPED.has(m) || /gender|race|ethnic|veteran|disabilit/.test(blob)) {
    if (answers.eeocDecline) return answers.eeocDeclineAnswer;
  }
  return "";
}

function controlLooksApplicationMapped(c) {
  if (!c) return false;
  const mapped = String(c.mappedTo || c.type || "").toLowerCase();
  if (APPLICATION_CONTROL_MAPPED.has(mapped)) return true;
  if (c.widgetType === "yesno") return true;
  if (c.widgetType === "radio" && (EEOC_MAPPED.has(mapped) || mapped === "visasponsorship" || mapped === "workauthorization")) {
    return true;
  }
  if (c.widgetType === "select" && APPLICATION_CONTROL_MAPPED.has(mapped)) return true;
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

/** One-shot Stagehand instruction for visa / EEOC when deterministic fill missed. */
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
  if (answers.eeocDecline) {
    parts.push(
      `For voluntary Gender, Race, Veteran status, and Disability questions, select "${answers.eeocDeclineAnswer}" (or "I do not want to answer" / "Prefer not to say" if shown)`,
    );
  }
  parts.push("Do not click Submit Application yet");
  return `${parts.join(". ")}.`;
}
