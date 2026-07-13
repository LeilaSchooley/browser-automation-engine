/**
 * Application-specific answers (visa, EEOC) — separate from job-search preferences.
 */

export const EEOC_MAPPED = new Set(["eeocgender", "eeocrace", "eeocveteran", "eeocdisability"]);

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

  return {
    needsVisaSponsorship: needsVisa,
    visaAnswer: needsVisa ? "Yes" : "No",
    eeocDecline,
    eeocDeclineAnswer: "Decline to self-identify",
  };
}

/** Resolve visa / EEOC answers from context preferences. */
export function resolveApplicationAnswer(mappedTo, label, context) {
  const m = String(mappedTo || "").toLowerCase();
  const blob = `${label || ""} ${m}`.toLowerCase();
  const answers = getApplicationAnswers(context);

  if (m === "visasponsorship" || /visa|sponsor|work\s*authorization|legally\s*authorized/.test(blob)) {
    return answers.visaAnswer;
  }
  if (EEOC_MAPPED.has(m) || /gender|race|ethnic|veteran|disabilit/.test(blob)) {
    if (answers.eeocDecline) return answers.eeocDeclineAnswer;
  }
  return "";
}

/** Unfilled Ashby-style yes/no or EEOC fieldsets on the current snap. */
export function hasUnfilledYesNoOrEEOC(snap) {
  if (!snap) return false;
  return (snap.customControls || []).some((c) => {
    if (c.filled) return false;
    if (c.widgetType === "yesno") return true;
    if (c.widgetType === "radio" && (EEOC_MAPPED.has(c.mappedTo) || c.mappedTo === "visasponsorship")) {
      return true;
    }
    return c.mappedTo === "visasponsorship" || EEOC_MAPPED.has(c.mappedTo);
  });
}

/** One-shot Stagehand instruction for visa / EEOC when deterministic fill missed. */
export function buildApplicationControlsStagehandInstruction(context = {}) {
  const answers = getApplicationAnswers(context);
  const parts = [];
  if (answers.visaAnswer) {
    parts.push(`For visa sponsorship or work authorization questions, click ${answers.visaAnswer}`);
  }
  if (answers.eeocDecline) {
    parts.push(
      `For voluntary Gender, Race, Veteran status, and Disability questions, select "${answers.eeocDeclineAnswer}" (or "I do not want to answer" if shown)`,
    );
  }
  parts.push("Do not click Submit Application yet");
  return `${parts.join(". ")}.`;
}
