/**
 * Multi-step / wizard form helpers — fill current step, advance, re-scan, fill again.
 * Does NOT blindly click every Next on the page (that breaks ATS traps).
 *
 * Single source of truth for completeness: `isStepComplete` / `currentStepIncomplete`.
 */
import { hasUnfilledApplicationFields } from "../heuristics.js";
import { looksLikeBoardSignupOnboarding } from "../platformOnboarding.js";
import { waasStepCompleteFromSnap } from "../siteAdapters/waasValidator.js";

/**
 * Stable-ish signature of the *current* wizard panel (fields + controls + continue CTA).
 * @param {object} snap
 */
export function stepSignature(snap) {
  if (!snap) return "";
  const fields = (snap.fields || [])
    .slice(0, 16)
    .map((f) => `${f.type || ""}:${String(f.label || "").slice(0, 32)}:${f.filled ? 1 : 0}`)
    .join("|");
  const ctrls = (snap.customControls || [])
    .slice(0, 12)
    .map((c) => `${c.widgetType || c.type || ""}:${String(c.label || "").slice(0, 32)}:${c.filled ? 1 : 0}`)
    .join("|");
  const cont = String(snap.continueCandidates?.[0]?.text || "").slice(0, 40);
  const path = (() => {
    try {
      return new URL(String(snap.url || "")).pathname;
    } catch {
      return String(snap.url || "").slice(0, 80);
    }
  })();
  return `${path}#${fields}#${ctrls}#${cont}`;
}

/** Path + query — used to detect Continue that failed to leave the step. */
export function stepPath(snap) {
  try {
    const u = new URL(String(snap?.url || ""));
    return `${u.pathname}${u.search}`;
  } catch {
    return String(snap?.url || "").slice(0, 120);
  }
}

function panelCompositionKey(snap) {
  const fields = (snap?.fields || [])
    .map((f) => `${f.type || ""}:${String(f.label || "").slice(0, 32)}`)
    .sort()
    .join("|");
  const ctrls = (snap?.customControls || [])
    .map((c) => `${c.mappedTo || c.widgetType || ""}:${String(c.label || "").slice(0, 32)}`)
    .sort()
    .join("|");
  return `${fields}#${ctrls}`;
}

/**
 * True when Continue meaningfully advanced the wizard (URL or panel composition).
 * Ignores filled-bit flips on the same panel (typeahead commit churn).
 * @param {object} before
 * @param {object} after
 */
export function wizardAdvanced(before, after) {
  if (!before || !after) return false;
  if (stepPath(before) !== stepPath(after)) return true;
  return panelCompositionKey(before) !== panelCompositionKey(after);
}

function isWidgetField(f) {
  return /combobox|contenteditable|select/i.test(String(f?.type || f?.widgetType || ""));
}

/** Continue/Next is present and not disabled — site validation already passed. */
export function hasEnabledContinue(snap) {
  if (!snap) return false;
  if ((snap.continueCount || 0) < 1 && (snap.modalStepCount || 0) < 1) return false;
  const top = snap.continueCandidates?.[0];
  if (top && top.disabled) return false;
  return true;
}

/**
 * Unfilled native text fields that are not also represented as custom widgets.
 * Comboboxes are duplicated into `fields` by the scanner — don't double-count them.
 * Orphan radio option fields (Yes/No labels) are never blockers — screening lives on customControls.
 */
function unfilledNativeTextFields(snap) {
  const customLabels = new Set(
    (snap.customControls || []).map((c) => String(c.label || "").toLowerCase().slice(0, 40)),
  );
  return (snap.fields || []).filter((f) => {
    if (f.filled) return false;
    if (/hidden|submit|button|file|checkbox|radio/i.test(String(f.type || ""))) return false;
    if (isWidgetField(f)) return false;
    const lab = String(f.label || "").toLowerCase().slice(0, 40);
    if (lab && customLabels.has(lab)) return false;
    return true;
  });
}

/** Dedupe custom controls by mappedTo/label — scanner can emit the same city 3×. */
export function uniqueCustomControls(snap) {
  const seen = new Set();
  const out = [];
  for (const c of snap?.customControls || []) {
    const key = `${String(c.mappedTo || c.widgetType || "").toLowerCase()}::${String(c.label || "")
      .toLowerCase()
      .slice(0, 48)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function isLocationLikeControl(c) {
  const mapped = String(c?.mappedTo || c?.type || "").toLowerCase();
  if (mapped === "location" || mapped === "relocatelocations") {
    const lab = String(c?.label || c?.questionLabel || "").toLowerCase();
    // Reject school/education labels that got mis-mapped as location.
    if (/\b(school|university|college|bootcamp|institute|academy)\b/i.test(lab)) return false;
    return true;
  }
  // Bare typeahead is NOT location — Role school autocomplete was poisoned this way.
  const lab = String(c?.label || "").toLowerCase();
  if (/\b(school|university|college|bootcamp)\b/i.test(lab)) return false;
  return /what city|city do you live|where (are|do) you live|city_current|live in/i.test(lab);
}

/**
 * Screening + Role questions that always block advance when unfilled.
 */
const SCREENING_BLOCKING_MAPPED = new Set([
  "visasponsorship",
  "workauthorization",
  "remotepreference",
  "willingtorelocate",
  "policyack",
  "jobfunction",
  "roleinterest",
  "fulltimestudent",
  "employmenttype",
  "engroles",
  "techskills",
  "schoolname",
]);

function isScreeningControl(c) {
  const mapped = String(c?.mappedTo || c?.type || "").toLowerCase();
  if (!SCREENING_BLOCKING_MAPPED.has(mapped)) return false;
  const widget = String(c?.widgetType || "");
  if (["yesno", "radio", "checkbox", "text"].includes(widget)) return true;
  if (widget === "combobox" && (mapped === "engroles" || mapped === "techskills" || mapped === "schoolname")) {
    return true;
  }
  return false;
}

/** Unfilled required screening controls on this step. */
function unfilledScreeningControls(snap) {
  return uniqueCustomControls(snap).filter((c) => !c.filled && isScreeningControl(c));
}

/**
 * Screening left unanswered by the last fill pass. Safety net for boards (WaaS)
 * where scanDom may not always emit the radios as customControls: the fill path
 * still discovers + reports them as unfilled, and that must block advancing.
 */
function unfilledScreeningFromFill(fillResult) {
  const unfilled = fillResult?.unfilled || [];
  return unfilled.filter((u) => {
    const mapped = String(u?.mappedTo || u?.type || "").toLowerCase();
    return SCREENING_BLOCKING_MAPPED.has(mapped);
  });
}

/**
 * City / location typeahead committed on this step (snap or fill evidence).
 * @param {object} snap
 * @param {object|null} fillResult
 */
export function locationTypeaheadCommitted(snap, fillResult = null) {
  const uniques = uniqueCustomControls(snap);
  const locCustoms = uniques.filter(isLocationLikeControl);
  if (locCustoms.length > 0 && locCustoms.every((c) => c.filled)) return true;
  if (locCustoms.some((c) => c.filled)) return true;
  const filled = fillResult?.filled || [];
  if (
    filled.some((f) => {
      const t = String(f?.type || f?.mappedTo || "").toLowerCase();
      return t === "location" || t === "relocatelocations" || t === "typeahead";
    })
  ) {
    return true;
  }
  // Combobox field marked filled (Places chip) when customControls lagged.
  return (snap.fields || []).some(
    (f) =>
      f.filled &&
      /combobox|typeahead/i.test(String(f.type || f.widgetType || "")) &&
      /city|location|live in/i.test(String(f.label || "")),
  );
}

function unfilledBlockingCustoms(snap) {
  return uniqueCustomControls(snap).filter((c) => {
    if (c.filled) return false;
    // Open listbox / ghost typeahead duplicates are not blockers when a sibling is filled.
    if (isLocationLikeControl(c)) {
      const siblings = uniqueCustomControls(snap).filter(isLocationLikeControl);
      if (siblings.some((s) => s.filled)) return false;
    }
    // Prefer explicit required flag when present; otherwise any unfilled custom counts.
    if (c.required === false) return false;
    return true;
  });
}

/**
 * Single source of truth: can we advance this wizard step?
 *
 * Site-enabled Continue + committed location typeahead wins over noisy field scans
 * (orphan Yes/No radio fields, open Places suggestion text in labels).
 *
 * @param {object} snap
 * @param {object|null} [fillResult]
 */
export function isStepComplete(snap, fillResult = null) {
  if (!snap) return false;
  // Board membership traps are not application wizards — never "complete".
  if (looksLikeBoardSignupOnboarding(snap)) return false;

  // WaaS: Inertia data-page serverErrors + visible Required markers — authoritative.
  const waasComplete = waasStepCompleteFromSnap(snap, fillResult);
  if (waasComplete === true) return true;
  if (waasComplete === false) return false;

  // Visible required markers (red *) without a WaaS payload still block advance.
  if (Number(snap?.waasValidation?.visibleRequiredCount) > 0) return false;

  const continueEnabled = hasEnabledContinue(snap);
  const locOk = locationTypeaheadCommitted(snap, fillResult);
  const blocking = unfilledBlockingCustoms(snap);
  const unfilledFields = unfilledNativeTextFields(snap);
  const unfilledScreening = unfilledScreeningControls(snap);

  // Unanswered required screening (visa/work-auth/remote/relocate/policy) always
  // blocks — the WaaS Continue button is enabled even when these are empty and
  // the site rejects the submit, so an enabled Continue is not proof of validity.
  if (unfilledScreening.length > 0) return false;
  if (unfilledScreeningFromFill(fillResult).length > 0) return false;

  // Native required fields (HTML required / aria-required) that are still empty.
  const unfilledRequiredNative = (snap.fields || []).filter(
    (f) => f.required && !f.filled && !/hidden|submit|button|file/i.test(String(f.type || "")),
  );
  if (unfilledRequiredNative.length > 0) return false;

  // WaaS Skills: never treat empty tech multi-select as complete.
  if (/\/application\/skills\b/i.test(String(snap.url || ""))) {
    const skillsCtrl = uniqueCustomControls(snap).find(
      (c) => String(c.mappedTo || "").toLowerCase() === "techskills",
    );
    if (skillsCtrl && !skillsCtrl.filled) return false;
    // scanDom often omits radio `checked` — do not block on snap radio state.
    // Live completeness is stamped onto techskills.filled / waasValidation in enrichSnap.
    if (snap?.waasValidation?.isSectionComplete === true) return true;
    const hasSkillChips = (snap.customControls || []).some(
      (c) => c.filled && /techskills/i.test(String(c.mappedTo || "")),
    );
    const hasSkillsCombobox = (snap.fields || []).some(
      (f) => /combobox|react-select/i.test(`${f.type || ""} ${f.label || ""} ${f.name || ""}`),
    );
    if (!hasSkillChips && hasSkillsCombobox) return false;
    // Proficiency radios present in snap but techskills not marked filled → incomplete.
    const hasProfRadios = (snap.fields || []).some((f) =>
      /^(beginner|intermediate|advanced)$/i.test(String(f.value || f.label || "").trim()),
    );
    if (hasProfRadios && !(skillsCtrl?.filled)) return false;
  }

  // WaaS Location: city committed + authoritative section complete (or no serverErrors).
  // Continue-enabled alone is never enough.
  const onLocationStep = /\/application\/location\b/i.test(String(snap.url || ""));
  if (
    onLocationStep &&
    locOk &&
    (snap?.waasValidation?.isSectionComplete === true ||
      (snap?.waasValidation?.available && !(snap?.waasValidation?.missing || []).length) ||
      (!snap?.waasValidation?.available && continueEnabled && blocking.length === 0 && unfilledFields.length === 0))
  ) {
    return true;
  }

  // Widget-only panel: completeness follows unique customs (not Continue enabled).
  const uniques = uniqueCustomControls(snap);
  if (uniques.length > 0 && (snap.fields || []).every((f) => isWidgetField(f) || /radio/i.test(String(f.type || "")))) {
    return blocking.length === 0;
  }

  if (hasUnfilledApplicationFields(snap, fillResult)) {
    if (uniques.length > 0 && blocking.length === 0 && unfilledFields.length === 0) {
      return true;
    }
    const blockingScreening = blocking.filter((c) => ["yesno", "radio"].includes(c.widgetType));
    if (blockingScreening.length > 0 || unfilledFields.length > 0) return false;
  }

  // All blocking customs + native text committed — complete without needing Continue enabled.
  return blocking.length === 0 && unfilledFields.length === 0 && uniques.every((c) => c.filled || !c.required);
}

/** Inverse of `isStepComplete` — kept for call sites. */
export function currentStepIncomplete(snap, fillResult = null) {
  if (!snap) return false;
  // Board traps: treat as incomplete for wizard advance (route away via page-role).
  if (looksLikeBoardSignupOnboarding(snap)) return true;
  return !isStepComplete(snap, fillResult);
}

/**
 * After a successful fill of the current step, Continue/Next is safe to prefer.
 * @param {object} snap
 * @param {object} [fillResult]
 */
export function shouldAutoAdvance(snap, fillResult = null) {
  if (!snap) return false;
  if (looksLikeBoardSignupOnboarding(snap)) return false;
  if (!hasEnabledContinue(snap)) return false;
  return isStepComplete(snap, fillResult);
}

/**
 * After Continue/Next, if a new step appeared with empty fields → force smart_fill.
 * @param {object} before
 * @param {object} after
 * @param {object} [fillResult]
 */
export function planAfterContinue(before, after, fillResult = null) {
  if (!after || looksLikeBoardSignupOnboarding(after)) return null;
  if (!wizardAdvanced(before, after)) return null;
  const fieldsGrew =
    (after.fieldCount || 0) > (before?.fieldCount || 0) ||
    uniqueCustomControls(after).filter((c) => !c.filled).length >
      uniqueCustomControls(before || {}).filter((c) => !c.filled).length;
  const newUnfilled = currentStepIncomplete(after, fillResult);
  if (newUnfilled || fieldsGrew) {
    return {
      type: "smart_fill",
      reason: "stepped form — new step appeared after Continue; fill before advancing again",
      source: "stepped-form",
      score: 97,
    };
  }
  return null;
}

/**
 * Looks like a multi-step flow (continue CTA + form surface).
 * @param {object} snap
 */
export function looksLikeSteppedForm(snap) {
  if (!snap) return false;
  if (looksLikeBoardSignupOnboarding(snap)) return false;
  // Auth / signup walls are not apply wizards (WWR register was mis-routed here).
  if (snap.authForm || snap.signupForm || (snap.passwordFieldCount || 0) > 0) {
    if ((snap.emailFieldCount || 0) > 0 || (snap.usernameFieldCount || 0) > 0) return false;
  }
  if (/\/(login|signin|sign-in|register|sign-up|signup|account)\b/i.test(String(snap.url || ""))) {
    if ((snap.passwordFieldCount || 0) > 0) return false;
  }
  const hasContinue = (snap.continueCount || 0) > 0 || (snap.modalStepCount || 0) > 0;
  const hasFields = (snap.fieldCount || 0) >= 1 || (snap.customControls || []).length >= 1;
  return hasContinue && hasFields;
}
