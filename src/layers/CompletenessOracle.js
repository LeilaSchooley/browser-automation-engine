/**
 * CompletenessOracle — single decision surface for "is this wizard step done?"
 *
 * Priority:
 *  1. Site-specific authoritative signals (WaaS serverErrors / sectionInfo, stamped snap)
 *  2. Profile/onboarding validation + required natives (WWR / Findwork step wizards)
 *  3. Existing steppedForm SSOT (`isStepComplete`) — DOM customs, screening, required natives
 *  4. Optional live page probes (Role/Skills adapters) when a Playwright page is provided
 *
 * Never treats "Continue enabled" alone as proof of completeness (that lives inside
 * isStepComplete with screening / Skills / Location guards).
 */

import { isStepComplete } from "./steppedForm.js";
import { enrichSnapWithWaasValidation } from "../siteAdapters/waasValidator.js";
import { assessBoardProfileCompleteness } from "../siteAdapters/wwrProfile.js";
import { looksLikeReachOutModal, looksLikeRequiredOutreachTextarea } from "../patterns/outreach.js";
import { looksLikeBoardSignupOnboarding } from "../platformOnboarding.js";

/**
 * @typedef {{ complete: boolean, reason: string, missing: string[] }} CompletenessResult
 */

/**
 * Collect missing keys from snap for diagnostics (not used alone for the decision).
 * @param {object} snap
 * @param {object|null} [fillResult]
 */
export function listMissingFromSnap(snap, fillResult = null) {
  const missing = [];
  const v = snap?.waasValidation;
  if (Array.isArray(v?.missing)) {
    for (const k of v.missing) missing.push(String(k));
  }
  if (Number(v?.visibleRequiredCount) > 0) missing.push("visible_required");

  if (looksLikeRequiredOutreachTextarea(snap)) {
    missing.push("outreach_message");
  }

  for (const c of snap?.customControls || []) {
    if (c.filled) continue;
    const mapped = String(c.mappedTo || c.type || "").toLowerCase();
    if (!mapped || mapped === "custom") continue;
    if (
      c.required ||
      [
        "techskills",
        "engroles",
        "jobfunction",
        "fulltimestudent",
        "employmenttype",
        "visasponsorship",
        "workauthorization",
        "location",
        "relocatelocations",
        "experiencelevel",
        "jobstatus",
        "salary",
        "desiredtitle",
      ].includes(mapped)
    ) {
      missing.push(mapped);
    }
  }

  for (const u of fillResult?.unfilled || []) {
    const m = String(u.mappedTo || u.type || "").toLowerCase();
    if (m) missing.push(m);
  }

  return [...new Set(missing)];
}

/**
 * Profile / account onboarding completeness — delegated to board profile adapter.
 * @param {object} snap
 * @param {object|null} [fillResult]
 * @returns {CompletenessResult|null} null when not a profile-setup surface
 */
export function assessProfileSetupCompleteness(snap, fillResult = null) {
  return assessBoardProfileCompleteness(snap, fillResult);
}

/**
 * Snap-only assessment (sync) — safe for wizardLoop / catalogs.
 * @param {object} snap
 * @param {object|null} [fillResult]
 * @returns {CompletenessResult}
 */
export function assessCompletenessFromSnap(snap, fillResult = null) {
  if (!snap) return { complete: false, reason: "no_snap", missing: ["snap"] };

  // Reach-out: bare textarea is required — never treat as optional chrome.
  if (looksLikeReachOutModal(snap) && looksLikeRequiredOutreachTextarea(snap)) {
    return {
      complete: false,
      reason: "outreach_message_required",
      missing: listMissingFromSnap(snap, fillResult),
    };
  }
  if (looksLikeReachOutModal(snap) && fillResult?.reach_out_ready) {
    return { complete: true, reason: "reach_out_ready", missing: [] };
  }

  // Board membership onboarding is not an apply wizard step.
  if (looksLikeBoardSignupOnboarding(snap)) {
    return {
      complete: false,
      reason: "not_applicable_page_role",
      missing: ["board_signup_onboarding"],
    };
  }

  const profile = assessProfileSetupCompleteness(snap, fillResult);
  if (profile && !profile.complete) return profile;

  const complete = isStepComplete(snap, fillResult);
  const missing = complete ? [] : listMissingFromSnap(snap, fillResult);
  return {
    complete,
    reason: complete ? "stepped_form_complete" : missing.length ? "snap_incomplete" : "incomplete",
    missing,
  };
}

/**
 * Full assessment with optional live page enrichment (Role/Skills DOM probes).
 * @param {import('playwright').Page|null} page
 * @param {object} snap
 * @param {object|null} [fillResult]
 * @returns {Promise<CompletenessResult>}
 */
export async function assessCompleteness(page, snap, fillResult = null) {
  let working = snap;
  let probeFailed = false;
  if (page && snap) {
    try {
      working = await enrichSnapWithWaasValidation(page, { ...snap });
    } catch (err) {
      probeFailed = true;
      working = snap;
    }
  }

  const fromSnap = assessCompletenessFromSnap(working, fillResult);
  if (fromSnap.complete) {
    return {
      ...fromSnap,
      reason: working?.waasValidation?.isSectionComplete ? "authoritative_or_dom" : fromSnap.reason,
    };
  }

  if (page) {
    try {
      const url = String(working?.url || page.url?.() || "");
      if (/\/application\/skills\b/i.test(url)) {
        const { waasSkillsDomLooksComplete } = await import("../siteAdapters/waasSkillsFields.js");
        if (await waasSkillsDomLooksComplete(page)) {
          return { complete: true, reason: "skills_dom_complete", missing: [] };
        }
      }
      if (/\/application\/role\b/i.test(url)) {
        const { waasRoleDomLooksComplete } = await import("../siteAdapters/waasRoleFields.js");
        if (await waasRoleDomLooksComplete(page)) {
          return { complete: true, reason: "role_dom_complete", missing: [] };
        }
      }
    } catch {
      probeFailed = true;
    }
  }

  if (probeFailed && !fromSnap.complete) {
    return {
      complete: false,
      reason: "oracle_probe_failed",
      missing: [...new Set([...(fromSnap.missing || []), "probe"])],
    };
  }

  return fromSnap;
}

/**
 * Authoritative required keys for ordering fills (learned map → serverErrors → snap unfilled).
 * @param {object} snap
 * @param {object|null} [learned]
 */
export function getAuthoritativeRequiredKeys(snap, learned = null) {
  if (Array.isArray(learned?.requiredOrder) && learned.requiredOrder.length) {
    return learned.requiredOrder.map(String);
  }
  const v = snap?.waasValidation;
  if (Array.isArray(v?.missing) && v.missing.length) return v.missing.map(String);

  return (snap?.customControls || [])
    .filter((c) => !c.filled)
    .map((c) => String(c.mappedTo || c.type || c.label || "").toLowerCase())
    .filter(Boolean);
}
