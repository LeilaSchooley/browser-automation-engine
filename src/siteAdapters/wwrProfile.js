/**
 * Board profile / onboarding adapter (WWR, Findwork-style step wizards).
 * CompletenessOracle delegates profile-setup assessment here — keep host-specific
 * label heuristics out of generic stepped-form SSOT.
 */

import { looksLikeProfileSetup } from "../patterns/profileSetup.js";

export function isBoardProfileHost(hostname = "") {
  const h = String(hostname || "").replace(/^www\./, "").toLowerCase();
  return (
    /(^|\.)weworkremotely\.com$/i.test(h) ||
    /(^|\.)findwork\.dev$/i.test(h) ||
    /onboarding\/step_/i.test(String(hostname || ""))
  );
}

const PROFILE_VALIDATION_RE =
  /please correct the following errors|can'?t be blank|is required|this field is required|must be (selected|filled|provided)/i;

/** Labels that typically appear on board profile onboarding steps. */
export const PROFILE_REQUIRED_LABEL_RES = [
  { key: "fullname", re: /full\s*name|your\s*name|^name\b/i },
  { key: "desiredtitle", re: /target\s*job\s*title|desired\s*job\s*title|job\s*title|preferred\s*title/i },
  { key: "experiencelevel", re: /experience\s*level|years?\s*of\s*experience|seniority/i },
  { key: "jobstatus", re: /job\s*status|employment\s*status|actively\s*looking|looking\s*for\s*work/i },
  { key: "salary", re: /preferred\s*salary|salary\s*range|compensation|pay\s*expect/i },
  { key: "resume", re: /upload\s*(your\s*)?(resume|cv)|resume\/?cv/i },
];

/**
 * Profile / account onboarding completeness — validation box + labeled empties.
 * @param {object} snap
 * @param {object|null} [fillResult]
 * @returns {{ complete: boolean, reason: string, missing: string[] }|null}
 */
export function assessBoardProfileCompleteness(snap, fillResult = null) {
  if (!snap || !looksLikeProfileSetup(snap)) return null;

  const missing = [];
  const body = `${snap.pageText || ""} ${snap.headings || ""} ${snap.title || ""}`.slice(0, 4000);

  if (PROFILE_VALIDATION_RE.test(body)) {
    missing.push("validation_errors");
  }

  for (const f of snap.fields || []) {
    if (/hidden|submit|button|file/i.test(String(f.type || ""))) continue;
    const label = `${f.label || ""} ${f.name || ""} ${f.placeholder || ""}`;
    const empty = !f.filled && !String(f.value || "").trim();
    if (!empty) continue;
    if (f.required || /\*/.test(label)) {
      const hit = PROFILE_REQUIRED_LABEL_RES.find((p) => p.re.test(label));
      missing.push(hit?.key || String(f.name || f.label || "required_field").toLowerCase());
    }
  }

  for (const { key, re } of PROFILE_REQUIRED_LABEL_RES) {
    if (key === "resume") continue;
    const matchingFields = (snap.fields || []).filter((f) => {
      if (/hidden|submit|button|file/i.test(String(f.type || ""))) return false;
      return re.test(`${f.label || ""} ${f.name || ""} ${f.placeholder || ""}`);
    });
    const matchingCustoms = (snap.customControls || []).filter((c) => {
      const mapped = String(c.mappedTo || "").toLowerCase();
      return mapped === key || re.test(`${c.label || ""} ${c.questionLabel || ""}`);
    });
    if (!matchingFields.length && !matchingCustoms.length) continue;

    const fieldHit = matchingFields.some((f) => f.filled || String(f.value || "").trim());
    const customHit = matchingCustoms.some((c) => c.filled);
    const filledAlready = (fillResult?.filled || []).some((e) => {
      const t = String(e.type || e.mappedTo || "").toLowerCase();
      return t === key || t.includes(key);
    });
    if (!fieldHit && !customHit && !filledAlready) missing.push(key);
  }

  if ((snap.fileInputCount || 0) > 0 && /resume|cv/i.test(body)) {
    const resumeFilled = (fillResult?.filled || []).some((e) =>
      /resume|file|cv/i.test(String(e.type || e.mappedTo || "")),
    );
    const resumeCustom = (snap.customControls || []).some(
      (c) => c.filled && /resume|cv/i.test(`${c.mappedTo || ""} ${c.label || ""}`),
    );
    const resumeShown = /\b[\w.-]+\.(pdf|docx?)\b/i.test(body) && /resume|cv/i.test(body);
    if (!resumeFilled && !resumeCustom && !resumeShown) missing.push("resume");
  }

  const uniq = [...new Set(missing)];
  if (uniq.length) {
    return {
      complete: false,
      reason: uniq.includes("validation_errors")
        ? "profile_validation_errors"
        : "profile_setup_incomplete",
      missing: uniq,
    };
  }

  return null;
}
