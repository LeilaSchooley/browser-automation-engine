/**
 * WaaS (workatastartup.com) authoritative validation from the Inertia `data-page`
 * payload — the site embeds serverErrors / sectionInfo in the DOM; this is ground
 * truth for wizard step completeness (not Continue enabled, not option label text).
 */

import { waasRoleDomLooksComplete } from "./waasRoleFields.js";

/** @param {string} [hostname] */
export function isWaasHost(hostname = "") {
  return /(^|\.)workatastartup\.com$/i.test(String(hostname || "").replace(/^www\./, ""));
}

/**
 * Parse WaaS validation state from a live page (Inertia `data-page` on the root div).
 * Falls back to visible client-side "Required" markers when props lag behind the DOM.
 *
 * @param {import('playwright').Page} page
 */
export async function getAuthoritativeValidation(page, opts = {}) {
  if (!page) {
    return emptyWaasValidation();
  }
  try {
    const hostname =
      opts.hostname ||
      (() => {
        try {
          return new URL(page.url()).hostname.replace(/^www\./, "");
        } catch {
          return "";
        }
      })();

    const result = await page.evaluate(() => {
      function empty() {
        return {
          available: false,
          serverErrors: {},
          sectionInfo: [],
          activeSection: "",
          currentSectionStatus: "",
          missing: [],
          visibleRequiredCount: 0,
          validationSource: "none",
          isSectionComplete: false,
        };
      }

      function parseDataPage() {
        const el =
          document.querySelector("[data-page]") ||
          document.querySelector("[id^='jobs/public/pages/'][data-page]") ||
          document.querySelector("div[data-page]");
        if (!el) return null;
        const raw = el.getAttribute("data-page") || "";
        if (!raw) return null;
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      }

      function countVisibleRequired() {
        const form = document.querySelector("form");
        if (!form) return 0;
        let count = 0;
        for (const node of form.querySelectorAll("*")) {
          const t = (node.textContent || "").replace(/\s+/g, " ").trim();
          // WaaS uses a red "*" next to labels; older boards use the word "Required".
          const isStar = t === "*" || t === "＊";
          const isWord = t === "Required" || t === "required";
          if (!isStar && !isWord) continue;
          const style = window.getComputedStyle(node);
          if (style.display === "none" || style.visibility === "hidden") continue;
          const r = node.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) continue;
          const color = style.color || "";
          const cls = String(node.className || "");
          if (
            !(
              isStar ||
              /rgb\(\s*239|rgb\(\s*220|#ef4444|#dc2626|red/i.test(color) ||
              /red/i.test(cls)
            )
          ) {
            continue;
          }
          // Only count markers whose nearby control is still empty — label asterisks
          // on already-filled fields must not block wizard advance.
          const block =
            node.closest("form div.mb-4, .mb-4, fieldset, [class*='field' i], label") ||
            node.parentElement;
          if (!block) {
            count += 1;
            continue;
          }
          const inputs = [
            ...block.querySelectorAll(
              "input:not([type='hidden']):not([type='submit']):not([type='button']), textarea, select, [role='combobox']",
            ),
          ].filter((el) => {
            const s = window.getComputedStyle(el);
            if (s.display === "none" || s.visibility === "hidden") return false;
            const br = el.getBoundingClientRect();
            return br.width > 1 && br.height > 1;
          });
          // Bare "*" with no associated control (legend/nav noise) — ignore.
          // Explicit "Required" text still means the section is incomplete.
          if (!inputs.length) {
            if (isWord) count += 1;
            continue;
          }
          const anyEmpty = inputs.some((el) => {
            if (el.type === "radio" || el.type === "checkbox") {
              const name = el.getAttribute("name") || "";
              if (!name) return !el.checked;
              const group = form.querySelectorAll(
                `input[type='${el.type}'][name="${CSS.escape(name)}"]`,
              );
              return ![...group].some((g) => g.checked);
            }
            if (el.tagName === "SELECT") return !el.value;
            const val = (el.value || el.textContent || "").replace(/\s+/g, " ").trim();
            if (!val) return true;
            if (/^select/i.test(val) || val === "…" || val === "...") return true;
            // react-select empty control often shows placeholder only
            if (el.getAttribute("role") === "combobox") {
              const multi = block.querySelectorAll("[class*='multi-value'], [class*='MultiValue']");
              if (multi.length) return false;
              const hidden = block.querySelector("input[type='hidden'][name]");
              if (hidden && String(hidden.value || "").trim()) return false;
              return !val || /select/i.test(val);
            }
            return false;
          });
          if (anyEmpty) count += 1;
        }
        return count;
      }

      const dataPage = parseDataPage();
      if (!dataPage) return empty();

      const props = dataPage?.props || {};
      const section = props.sectionAppProps || props.section || {};
      const serverErrors = section.serverErrors || props.serverErrors || {};
      const sectionInfo = section.sectionInfo || props.sectionInfo || [];
      const activeSection = section.activeSection || props.activeSection || "";
      const missing = Object.keys(serverErrors || {}).filter(
        (k) => Array.isArray(serverErrors[k]) && serverErrors[k].length > 0,
      );

      const current = sectionInfo.find((s) => s.name === activeSection || s.status === "current") || null;
      const currentSectionStatus = current?.status || "";
      const visibleRequiredCount = countVisibleRequired();

      const hasServerErrors = missing.length > 0;
      const hasClientRequired = visibleRequiredCount > 0;
      const isSectionComplete =
        !hasServerErrors && !hasClientRequired && (currentSectionStatus === "complete" || missing.length === 0);

      return {
        available: true,
        serverErrors,
        sectionInfo,
        activeSection,
        currentSectionStatus,
        missing,
        visibleRequiredCount,
        validationSource: hasServerErrors ? "serverErrors" : hasClientRequired ? "domRequired" : "sectionInfo",
        isSectionComplete,
      };
    });

    if (result?.available) return result;
    if (!isWaasHost(hostname)) return emptyWaasValidation();
    return result?.available ? result : emptyWaasValidation();
  } catch {
    return emptyWaasValidation();
  }
}

export function emptyWaasValidation() {
  return {
    available: false,
    serverErrors: {},
    sectionInfo: [],
    activeSection: "",
    currentSectionStatus: "",
    missing: [],
    visibleRequiredCount: 0,
    validationSource: "none",
    isSectionComplete: false,
  };
}

/**
 * Authoritative WaaS step completeness from snap.waasValidation (set during inspectPage).
 * Returns `null` when not on WaaS or no payload — caller falls back to DOM heuristics.
 *
 * @param {object} snap
 * @param {object|null} [fillResult]
 * @returns {boolean|null}
 */
export function waasStepCompleteFromSnap(snap, fillResult = null) {
  const v = snap?.waasValidation;
  if (!v?.available) return null;

  // Role step: ignore phantom Location/salary unfilled from prefs heuristics —
  // only Role serverErrors + empty required markers matter.
  const onRole = /\/application\/role\b/i.test(String(snap?.url || ""));
  const onSkills = /\/application\/skills\b/i.test(String(snap?.url || ""));
  const roleMissingKeys = new Set(["role", "in_school", "job_type", "eng_type"]);
  const missing = Array.isArray(v.missing) ? v.missing : [];
  const roleMissing = missing.filter((k) => roleMissingKeys.has(k));

  if (onRole) {
    if (roleMissing.length > 0) return false;
    if ((v.visibleRequiredCount || 0) > 0) return false;
    // serverErrors clear + no empty required markers → advance even if fillResult
    // still lists phantom location/salary unfilled.
    return true;
  }

  // Skills: serverErrors may be empty while the multi-select is still blank —
  // defer to DOM chip / techskills heuristics in isStepComplete.
  if (onSkills) {
    if (missing.length > 0) return false;
    if ((v.visibleRequiredCount || 0) > 0) return false;
    return null;
  }

  const fillUnfilled = (fillResult?.unfilled || []).length;
  if (missing.length > 0) return false;
  if ((v.visibleRequiredCount || 0) > 0) return false;
  if (fillUnfilled > 0) return false;

  if (v.isSectionComplete) return true;
  if (missing.length === 0 && (v.visibleRequiredCount || 0) === 0) return true;
  return false;
}

/**
 * Attach WaaS validation to snap during inspectPage enrichment.
 * @param {import('playwright').Page} page
 * @param {object} snap
 */
export async function enrichSnapWithWaasValidation(page, snap) {
  if (!snap) return snap;
  const host = String(snap.hostname || "").replace(/^www\./, "");
  const urlHost = (() => {
    try {
      return new URL(snap.url || page.url?.() || "").hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  })();
  if (!isWaasHost(host) && !isWaasHost(urlHost) && !/\/application\//i.test(String(snap.url || ""))) {
    return snap;
  }
  snap.waasValidation = await getAuthoritativeValidation(page, { hostname: host || urlHost });

  // Role: when core radios/checkboxes are committed, clear stale * counts that
  // otherwise keep the wizard in fill_missing_required forever.
  const onRole = /\/application\/role\b/i.test(String(snap.url || page.url?.() || ""));
  if (onRole && snap.waasValidation?.available) {
    try {
      if (await waasRoleDomLooksComplete(page)) {
        snap.waasValidation = {
          ...snap.waasValidation,
          visibleRequiredCount: 0,
          missing: (snap.waasValidation.missing || []).filter(
            (k) => !["role", "in_school", "job_type", "eng_type"].includes(k),
          ),
          isSectionComplete: true,
        };
      }
    } catch {
      /* keep raw validation */
    }
  }

  const onSkills = /\/application\/skills\b/i.test(String(snap.url || page.url?.() || ""));
  if (onSkills) {
    try {
      const { waasSkillsDomLooksComplete } = await import("./waasSkillsFields.js");
      if (await waasSkillsDomLooksComplete(page)) {
        if (snap.waasValidation) {
          snap.waasValidation = {
            ...snap.waasValidation,
            available: true,
            visibleRequiredCount: 0,
            missing: [],
            isSectionComplete: true,
          };
        } else {
          snap.waasValidation = {
            available: true,
            visibleRequiredCount: 0,
            missing: [],
            isSectionComplete: true,
          };
        }
        for (const c of snap.customControls || []) {
          if (String(c.mappedTo || "").toLowerCase() === "techskills") c.filled = true;
        }
      }
    } catch {
      /* keep raw */
    }
  }
  return snap;
}
