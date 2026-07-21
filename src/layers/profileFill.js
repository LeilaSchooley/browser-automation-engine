/**
 * Fill board profile / account onboarding with permanent core profile data
 * (not job-application-only answers).
 *
 * Long-term path:
 *  1. Sequential fill of every core required field (name, title, experience, status, salary, …)
 *  2. Smart fill for resume / remaining natives
 *  3. universalFill for custom controls + structure learning
 *  4. CompletenessOracle before Continue
 *  5. URL/step change as the final advance confirmation
 */
import { humanPause, humanType } from "../human.js";
import { getApplicantProfile } from "../fillProfile.js";
import { getPreferencesFromContext } from "../fillPreferences.js";
import { runSmartFill } from "../smartFill.js";
import { inspectPage } from "./formDiscovery.js";
import { clickDiscoveredContinue } from "./domActions.js";
import { looksLikeProfileSetup } from "../patterns/profileSetup.js";
import { visible } from "./fillWidgets/shared.js";
import { assessCompleteness } from "./CompletenessOracle.js";
import { runUniversalFill } from "./universalFillPipeline.js";
import { maybeLearnSiteStructure } from "../siteStructureLearner.js";
import { verifyAdvance } from "./transition.js";

/**
 * Permanent user profile for onboarding wizards.
 * @param {object} context
 */
export function getCoreProfile(context = {}) {
  const applicant = getApplicantProfile(context);
  const prefs = getPreferencesFromContext(context);
  const p = context.preferences || {};
  const a = context.applicant || context.profile || {};

  const experienceLevel = String(
    p.experienceLevel || a.experienceLevel || p.experience_level || "Mid-level",
  ).trim();
  const jobStatus = String(
    p.jobStatus || a.jobStatus || p.job_status || "Actively looking",
  ).trim();
  const salaryRange = String(
    prefs.salary || p.salaryRange || a.salaryRange || prefs.salaryExpectation || "",
  ).trim();

  return {
    ...applicant,
    desiredTitle: prefs.desiredTitle || String(context.job?.title || "").trim(),
    experienceLevel,
    jobStatus,
    salaryRange,
    salary: salaryRange,
    location: prefs.location || [applicant.city, applicant.country].filter(Boolean).join(", "),
  };
}

/** Canonical core keys in fill order — also used for structure learning. */
export const PROFILE_REQUIRED_ORDER = [
  "fullname",
  "desiredtitle",
  "experiencelevel",
  "jobstatus",
  "salary",
  "resume",
];

const PROFILE_FIELD_MAP = [
  {
    keys: ["fullname", "name"],
    labelRe: /full\s*name|your\s*name|^name$/i,
    valueOf: (c) => c.fullName,
    force: true,
  },
  {
    keys: ["desiredtitle", "title"],
    labelRe: /target\s*job\s*title|desired\s*job\s*title|job\s*title|preferred\s*title/i,
    valueOf: (c) => c.desiredTitle,
    force: true,
  },
  {
    keys: ["experiencelevel"],
    labelRe: /experience\s*level|years?\s*of\s*experience|seniority/i,
    valueOf: (c) => c.experienceLevel,
    aliases: (v) => experienceAliases(v),
  },
  {
    keys: ["jobstatus"],
    labelRe: /job\s*status|employment\s*status|looking\s*for\s*work|actively\s*looking/i,
    valueOf: (c) => c.jobStatus,
    aliases: (v) => jobStatusAliases(v),
  },
  {
    keys: ["salary", "salaryrange"],
    labelRe: /preferred\s*salary|salary\s*range|compensation|pay\s*expect/i,
    valueOf: (c) => c.salaryRange,
  },
  {
    keys: ["location", "city"],
    labelRe: /^(city|location|where\s*are\s*you)|live\s*in/i,
    valueOf: (c) => c.city || c.location,
  },
];

function experienceAliases(value) {
  const v = String(value || "").toLowerCase();
  const out = [String(value || "").trim()].filter(Boolean);
  if (/mid|intermediate|3|4|5/.test(v)) {
    out.push("Mid-level", "Mid level", "Mid", "Intermediate", "3-5 years", "2-4 years", "3+ years");
  }
  if (/senior|lead|principal|staff|5\+|6|7|8|9|10/.test(v)) {
    out.push("Senior", "Lead", "5+ years", "5-10 years", "10+ years");
  }
  if (/entry|junior|intern|0|1|2/.test(v)) {
    out.push("Entry-level", "Entry level", "Junior", "0-2 years", "1-2 years");
  }
  return [...new Set(out.filter(Boolean))];
}

function jobStatusAliases(value) {
  const v = String(value || "").toLowerCase();
  const out = [String(value || "").trim()].filter(Boolean);
  if (/active|looking|search/.test(v)) {
    out.push("Actively looking", "Actively Looking", "Looking", "Open to work");
  }
  if (/open|passive|opportun/.test(v)) {
    out.push("Open to opportunities", "Open to Opportunities", "Passive");
  }
  if (/not\s*looking|employed|unavailable/.test(v)) {
    out.push("Not looking", "Employed", "Unavailable");
  }
  return [...new Set(out.filter(Boolean))];
}

/**
 * Click a radio / option / button whose accessible name matches one of the candidates.
 */
async function clickChoiceNearLabel(page, labelRe, candidates, log) {
  const names = (candidates || []).map(String).filter(Boolean);
  if (!names.length) return false;

  for (const name of names) {
    try {
      const radio = page.getByRole("radio", { name: new RegExp(escapeRe(name), "i") });
      if ((await radio.count()) > 0 && (await visible(radio.first()))) {
        await radio.first().click({ timeout: 4000 });
        log?.layer?.("profile_fill", `clicked radio "${name}"`, "info");
        return true;
      }
    } catch {
      /* next */
    }
    try {
      const opt = page.getByRole("option", { name: new RegExp(escapeRe(name), "i") });
      if ((await opt.count()) > 0 && (await visible(opt.first()))) {
        await opt.first().click({ timeout: 4000 });
        log?.layer?.("profile_fill", `clicked option "${name}"`, "info");
        return true;
      }
    } catch {
      /* next */
    }
    try {
      const btn = page.getByRole("button", { name: new RegExp(`^${escapeRe(name)}$`, "i") });
      if ((await btn.count()) > 0 && (await visible(btn.first()))) {
        await btn.first().click({ timeout: 4000 });
        log?.layer?.("profile_fill", `clicked button "${name}"`, "info");
        return true;
      }
    } catch {
      /* next */
    }
  }

  // Open labeled combobox / select-like control, then pick an option.
  try {
    const combo = page.getByLabel(labelRe, { exact: false });
    if ((await combo.count()) > 0 && (await visible(combo.first()))) {
      const tag = await combo.first().evaluate((el) => (el.tagName || "").toLowerCase()).catch(() => "");
      if (tag === "select") {
        for (const name of names) {
          const ok = await combo
            .first()
            .selectOption({ label: name })
            .then(() => true)
            .catch(() => false);
          if (ok) {
            log?.layer?.("profile_fill", `select option "${name}"`, "info");
            return true;
          }
        }
      } else {
        await combo.first().click({ timeout: 3000 }).catch(() => {});
        await humanPause(200, 400);
        for (const name of names) {
          const opt = page.getByRole("option", { name: new RegExp(escapeRe(name), "i") });
          if ((await opt.count()) > 0) {
            await opt.first().click({ timeout: 3000 });
            log?.layer?.("profile_fill", `combobox option "${name}"`, "info");
            return true;
          }
          const textOpt = page.getByText(new RegExp(`^${escapeRe(name)}$`, "i"));
          if ((await textOpt.count()) > 0 && (await visible(textOpt.first()))) {
            await textOpt.first().click({ timeout: 3000 });
            log?.layer?.("profile_fill", `list option "${name}"`, "info");
            return true;
          }
        }
      }
    }
  } catch {
    /* fall through */
  }

  return false;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Fill a visible text/select/radio control by label or nearby text.
 * @param {import('playwright').Page} page
 * @param {object} field
 * @param {string} value
 * @param {object|null} log
 */
async function fillByLabel(page, field, value, log) {
  if (!value) return false;
  const labelRe = field.labelRe;
  const candidates = field.aliases ? field.aliases(value) : [String(value)];
  const force = Boolean(field.force);

  // Choice widgets (experience / status) first.
  if (field.keys?.[0] === "experiencelevel" || field.keys?.[0] === "jobstatus") {
    if (await clickChoiceNearLabel(page, labelRe, candidates, log)) return true;
  }

  try {
    const byLabel = page.getByLabel(labelRe, { exact: false });
    if ((await byLabel.count()) > 0 && (await visible(byLabel.first()))) {
      const tag = await byLabel.first().evaluate((el) => (el.tagName || "").toLowerCase()).catch(() => "");
      if (tag === "select") {
        for (const name of candidates) {
          const ok = await byLabel
            .first()
            .selectOption({ label: name })
            .then(() => true)
            .catch(() =>
              byLabel
                .first()
                .selectOption({ value: name })
                .then(() => true)
                .catch(() => false),
            );
          if (ok) {
            log?.layer?.("profile_fill", `filled select via label ${labelRe}`, "info");
            return true;
          }
        }
      } else {
        const cur = await byLabel.first().inputValue().catch(() => "");
        if (force || !String(cur || "").trim()) {
          await byLabel.first().fill("").catch(() => {});
          await humanType(byLabel.first(), String(value), page);
        }
        log?.layer?.("profile_fill", `filled via label ${labelRe}`, "info");
        return true;
      }
    }
  } catch {
    /* next */
  }

  if (await clickChoiceNearLabel(page, labelRe, candidates, log)) return true;

  // Label text → following input/select
  const filled = await page
    .evaluate(
      ({ source, flags, vals, forceWrite }) => {
        const re = new RegExp(source, flags);
        const labels = [...document.querySelectorAll("label, legend, p, span, div")];
        for (const lab of labels) {
          const t = String(lab.textContent || "").replace(/\s+/g, " ").trim();
          if (t.length < 2 || t.length > 80 || !re.test(t)) continue;
          let input =
            lab.querySelector("input, select, textarea") ||
            (lab.getAttribute("for") && document.getElementById(lab.getAttribute("for")));
          if (!input) {
            const wrap = lab.closest("div, fieldset, li, section") || lab.parentElement;
            input = wrap?.querySelector?.("input:not([type='hidden']):not([type='file']), select, textarea");
          }
          if (!input) {
            // Radio / button group in the same wrap
            const wrap = lab.closest("div, fieldset, li, section") || lab.parentElement;
            for (const cand of vals) {
              const hit = [...(wrap?.querySelectorAll?.("input[type=radio], button, [role=radio], [role=option]") || [])].find(
                (el) => {
                  const n = `${el.getAttribute("aria-label") || ""} ${el.value || ""} ${el.textContent || ""}`
                    .replace(/\s+/g, " ")
                    .trim()
                    .toLowerCase();
                  return n.includes(String(cand).toLowerCase());
                },
              );
              if (hit) {
                hit.click();
                return true;
              }
            }
            continue;
          }
          const style = window.getComputedStyle(input);
          if (style.display === "none" || style.visibility === "hidden") continue;
          if (input.tagName === "SELECT") {
            const opts = [...input.options];
            for (const cand of vals) {
              const match =
                opts.find((o) => o.text.trim().toLowerCase() === String(cand).toLowerCase()) ||
                opts.find((o) => o.text.toLowerCase().includes(String(cand).toLowerCase()));
              if (match) {
                input.value = match.value;
                input.dispatchEvent(new Event("input", { bubbles: true }));
                input.dispatchEvent(new Event("change", { bubbles: true }));
                return true;
              }
            }
            return false;
          }
          if (!forceWrite && String(input.value || "").trim()) return true;
          input.focus();
          input.value = String(vals[0] || "");
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
        return false;
      },
      {
        source: labelRe.source,
        flags: labelRe.flags,
        vals: candidates,
        forceWrite: force,
      },
    )
    .catch(() => false);

  if (filled) {
    log?.layer?.("profile_fill", `filled via nearby label ${labelRe}`, "info");
    await humanPause(200, 350);
  }
  return Boolean(filled);
}

/**
 * @param {import('playwright').Page} page
 * @param {object} snap
 * @param {object} context
 * @param {object|null} log
 */
export async function fillProfileSetup(page, snap, context, log = null, { sessionId = null } = {}) {
  if (!looksLikeProfileSetup(snap)) {
    return { ok: false, filled: [], reason: "not_profile_setup" };
  }

  const core = getCoreProfile(context);
  const profileContext = {
    ...context,
    preferences: {
      ...(context.preferences || {}),
      desiredTitle: core.desiredTitle,
      desiredJobTitle: core.desiredTitle,
      experienceLevel: core.experienceLevel,
      jobStatus: core.jobStatus,
      salary: core.salaryRange,
      salaryExpectation: core.salaryRange,
      salaryRange: core.salaryRange,
      location: core.location,
    },
    applicant: {
      ...(context.applicant || context.profile || {}),
      ...core,
    },
  };

  log?.layer?.(
    "profile_fill",
    `filling profile setup — name=${core.fullName || "?"} title=${core.desiredTitle || "?"} exp=${core.experienceLevel} status=${core.jobStatus} salary=${core.salaryRange || "?"}`,
    "info",
  );

  const filled = [];
  for (const field of PROFILE_FIELD_MAP) {
    const value = field.valueOf(core);
    if (!value) continue;
    if (await fillByLabel(page, field, value, log)) {
      filled.push({
        type: field.keys[0],
        mappedTo: field.keys[0],
        source: "profile_fill",
        value: String(value).slice(0, 60),
      });
    }
  }

  // Resume + remaining natives (sessionId → correct job resume).
  const smart = await runSmartFill(page, profileContext, log, {
    snap,
    sessionId: sessionId ?? context?.job?.id ?? null,
  });
  for (const entry of smart.filled || []) {
    filled.push(entry);
  }

  // Chronological customs + structure learning (experience/status widgets, etc.).
  let after = await inspectPage(page).catch(() => snap);
  const uni = await runUniversalFill(page, profileContext, log, {
    snap: after,
    allFilled: filled,
    maxPasses: 2,
    learnOnComplete: false,
  });
  if (uni.snap) after = uni.snap;
  for (const entry of uni.filled || []) {
    filled.push(entry);
  }

  await humanPause(400, 700);
  after = await inspectPage(page).catch(() => after);
  const urlBefore = String(after.url || snap?.url || "");
  const fillResult = { filled, unfilled: smart.unfilled || [] };

  // Primary gate: CompletenessOracle — never Continue on incomplete / validation errors.
  let oracle = await assessCompleteness(page, after, fillResult);
  if (!oracle.complete && oracle.missing?.length) {
    log?.layer?.(
      "profile_fill",
      `oracle incomplete (${oracle.reason}) missing=[${oracle.missing.slice(0, 8).join(", ")}] — retry fill`,
      "warn",
    );
    for (const field of PROFILE_FIELD_MAP) {
      if (!oracle.missing.some((m) => field.keys.includes(String(m).toLowerCase()))) continue;
      const value = field.valueOf(core);
      if (!value) continue;
      if (await fillByLabel(page, { ...field, force: true }, value, log)) {
        filled.push({
          type: field.keys[0],
          mappedTo: field.keys[0],
          source: "profile_fill_retry",
          value: String(value).slice(0, 60),
        });
      }
    }
    after = await inspectPage(page).catch(() => after);
    oracle = await assessCompleteness(page, after, { filled });
  }

  let advanced = false;
  let continueClicked = false;

  if (!oracle.complete) {
    log?.layer?.(
      "profile_fill",
      `skip continue — oracle=${oracle.reason} missing=[${(oracle.missing || []).slice(0, 8).join(", ")}]`,
      "warn",
    );
  } else if ((after.continueCount || 0) > 0) {
    continueClicked = await clickDiscoveredContinue(page, log, "profile_fill", after);
    if (continueClicked) {
      await humanPause(900, 1600);
      after = await inspectPage(page).catch(() => after);
      const urlAfter = String(after.url || "");
      const verdict = verifyAdvance(
        { url: urlBefore, fieldCount: snap?.fieldCount, pageKind: snap?.pageKind },
        after,
      );
      // Same onboarding step identity never counts as advanced.
      advanced = Boolean(verdict.advanced) && !sameOnboardingStep(urlBefore, urlAfter);
      if (!advanced) {
        log?.layer?.(
          "profile_fill",
          `continue clicked but step did not advance (${shortPath(urlAfter) || "unknown"})`,
          "warn",
        );
      } else {
        // Learn required order for this onboarding step after a real advance.
        await maybeLearnSiteStructure(page, snap, {
          log,
          afterAdvance: true,
          requiredOrder: [
            ...PROFILE_REQUIRED_ORDER,
            ...(uni.preferredOrder || []),
            ...filled.map((f) => f.mappedTo || f.type).filter(Boolean),
          ],
        }).catch(() => null);
      }
    }
  }

  const ok = filled.length > 0;
  log?.layer?.(
    "profile_fill",
    `${ok ? "done" : "incomplete"} — filled=${filled.length} advanced=${advanced} oracle=${oracle.complete ? oracle.reason : `no:${oracle.reason}`}`,
    ok ? "info" : "warn",
  );

  return {
    ok,
    filled,
    snap: after,
    advanced,
    continueClicked,
    oracle,
    stuckOnStep: continueClicked && !advanced,
    reason: advanced
      ? "profile_advanced"
      : !oracle.complete
        ? "profile_oracle_incomplete"
        : ok
          ? continueClicked
            ? "profile_filled_continue_stuck"
            : "profile_filled"
          : "profile_incomplete",
  };
}

function shortPath(url = "") {
  try {
    return new URL(url).pathname || url;
  } catch {
    return String(url || "").slice(0, 80);
  }
}

/** True when both URLs are the same onboarding step (e.g. both …/step_1). */
function sameOnboardingStep(a = "", b = "") {
  const stepOf = (u) => {
    const m = String(u).match(/\/onboarding\/(step_\d+|[^/?#]+)/i);
    return m ? m[1].toLowerCase() : shortPath(u);
  };
  return stepOf(a) === stepOf(b);
}
