/**
 * Profile / account onboarding pages (WWR step_1, Findwork profile, etc.).
 * Distinct from job-application ATS forms and auth walls.
 */

export const PROFILE_SETUP_URL_RE =
  /\/(onboarding|profile|account\/setup|job-seekers\/onboarding|users\/edit|complete-profile)/i;

export const PROFILE_SETUP_COPY_RE =
  /\b(step\s*\d+\s*of\s*\d+|about you|tell us about yourself|complete your profile|set up your profile|create your profile|target job title|experience level|job status|preferred salary|your full name)\b/i;

export const PROFILE_FIELD_LABEL_RE =
  /\b(full\s*name|target\s*job\s*title|experience\s*level|job\s*status|preferred\s*salary|salary\s*range|upload\s*(your\s*)?resume)\b/i;

/** Pure job-application signals — not board profile onboarding. */
export const JOB_APPLY_COPY_RE =
  /\b(apply for this job|submit application|cover letter|eeoc|equal employment|work authorization|visa sponsorship)\b/i;

/**
 * Snap-level detector (no Playwright).
 * @param {object} snap
 * @returns {{ isProfileSetup: boolean, reason: string, score: number }}
 */
export function detectProfileSetupFromSnap(snap) {
  if (!snap) return { isProfileSetup: false, reason: "no_snap", score: 0 };

  const url = String(snap.url || "");
  const body = `${snap.pageText || ""} ${snap.headings || ""} ${snap.title || ""} ${snap.applyModalTitle || ""}`
    .toLowerCase()
    .slice(0, 3500);

  // Auth walls are not profile setup.
  if ((snap.passwordFieldCount || 0) > 0 && /\/(login|signin|register|sign-up)/i.test(url)) {
    return { isProfileSetup: false, reason: "auth_wall", score: 0 };
  }

  const fieldBlob = (snap.fields || [])
    .map((f) => `${f.label || ""} ${f.name || ""} ${f.placeholder || ""}`)
    .join(" ")
    .toLowerCase();

  let score = 0;
  const hits = [];

  if (PROFILE_SETUP_URL_RE.test(url)) {
    score += 2;
    hits.push("url");
  }
  if (/step\s*\d+\s*of\s*\d+/i.test(body)) {
    score += 2;
    hits.push("step_counter");
  }
  if (PROFILE_SETUP_COPY_RE.test(body)) {
    score += 1;
    hits.push("copy");
  }
  if (PROFILE_FIELD_LABEL_RE.test(fieldBlob) || PROFILE_FIELD_LABEL_RE.test(body)) {
    score += 1;
    hits.push("field_labels");
  }
  if (/please correct the following errors|can'?t be blank/i.test(body)) {
    score += 1;
    hits.push("validation_errors");
  }

  const isJobApply =
    JOB_APPLY_COPY_RE.test(body) &&
    !/step\s*\d+\s*of\s*\d+/i.test(body) &&
    !PROFILE_SETUP_URL_RE.test(url);

  if (isJobApply) {
    return { isProfileSetup: false, reason: "job_application", score };
  }

  const isProfileSetup = score >= 2;
  return {
    isProfileSetup,
    reason: isProfileSetup ? hits.join("+") || "profile_signals" : "weak_signals",
    score,
  };
}

/**
 * @param {object} snap
 */
export function looksLikeProfileSetup(snap) {
  return detectProfileSetupFromSnap(snap).isProfileSetup;
}
