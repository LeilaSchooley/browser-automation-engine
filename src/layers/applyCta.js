/**
 * Strong Apply / Reach-out CTA discovery for zero-field job detail pages.
 * Prefer deterministic clicks; Stagehand only once with a scoped instruction.
 * Returns TransitionResult — clicked ≠ advanced.
 */
import { humanPause } from "../human.js";
import { canUseStagehand, attemptStagehandAct } from "./stagehandAdapter.js";
import { inspectPage, pageFingerprint } from "./formDiscovery.js";
import { clickCandidate } from "./domActions.js";
import { rankEntryCandidates } from "./pageIntent.js";
import {
  toTransitionResult,
  countUnverifiedAttempts,
  MAX_UNVERIFIED_APPLY_CTA,
} from "./transition.js";

const HIGH_CONFIDENCE_TEXTS = [
  /^apply for (this |the )?job$/i,
  /^apply to (this )?role/i,
  /^apply now$/i,
  /^apply$/i,
  /^reach out$/i,
  /^apply for this job$/i,
  /^apply to role/i,
];

/**
 * Live DOM scan for visible Apply / Reach out controls.
 * @param {import('playwright').Page} page
 * @returns {Promise<{ selector?: string, text: string, score: number }|null>}
 */
export async function findBestApplyCta(page) {
  const found = await page
    .evaluate(() => {
      const texts = [
        /^apply for (this |the )?job$/i,
        /^apply to (this )?role/i,
        /^apply now$/i,
        /^reach out$/i,
        /^apply$/i,
      ];
      const nodes = [
        ...document.querySelectorAll(
          'a, button, [role="button"], input[type="submit"], input[type="button"]',
        ),
      ];
      const scored = [];
      for (const el of nodes) {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue;
        const text = String(
          el.innerText || el.value || el.getAttribute("aria-label") || el.textContent || "",
        )
          .replace(/\s+/g, " ")
          .trim();
        if (!text || text.length > 80) continue;
        // Never score filter/search controls as Apply.
        if (/apply\s*filters?|filter(s)?\s*jobs?|search\s*jobs?|refine\s*search/i.test(text)) continue;
        let score = 0;
        for (let i = 0; i < texts.length; i += 1) {
          if (texts[i].test(text)) {
            score = 120 - i * 5;
            break;
          }
        }
        if (!score && /\bapply\b/i.test(text) && !/sign|log|login|register/i.test(text)) {
          score = 70;
        }
        if (!score && /reach out/i.test(text)) score = 95;
        if (!score) continue;
        // Prefer main content over footer/nav.
        const inNav = Boolean(el.closest("nav, header, footer, [role='navigation']"));
        if (inNav) score -= 25;
        scored.push({
          text,
          score,
          tag: el.tagName.toLowerCase(),
          href: el.href || "",
        });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored[0] || null;
    })
    .catch(() => null);

  return found;
}

/**
 * Prefer snap entryCandidates when present; else live DOM CTA.
 * @param {import('playwright').Page} page
 * @param {object|null} snap
 * @param {object} context
 */
export async function resolveApplyCta(page, snap, context = {}) {
  const ranked = rankEntryCandidates(snap?.entryCandidates || [], context).filter(
    (c) => !/apply\s*filters?|filter(s)?\s*jobs?|search\s*jobs?/i.test(`${c.text || ""} ${c.testId || ""}`),
  );
  if (ranked[0] && (ranked[0].score || 0) >= 50) {
    return {
      source: "snap",
      candidate: ranked[0],
      text: ranked[0].text || "",
      score: ranked[0].score || 0,
    };
  }
  const live = await findBestApplyCta(page);
  if (live) {
    return { source: "live", candidate: live, text: live.text, score: live.score };
  }
  return null;
}

/**
 * Count Apply/Stagehand CTA attempts on this fingerprint.
 * @param {object[]} history
 * @param {string} pageHash
 */
export function countApplyCtaAttempts(history, pageHash) {
  const fp = String(pageHash || "");
  return (history || []).filter(
    (h) =>
      (h.action === "click_apply" || h.source === "apply-cta" || h.applyCta) &&
      (!fp || h.fingerprint === fp),
  ).length;
}

/**
 * Click Apply/Reach out on zero-field job details. One Stagehand attempt max.
 * Returns TransitionResult (+ source/text/handoff helpers).
 *
 * @param {import('playwright').Page} page
 * @param {object} snap
 * @param {object} context
 * @param {object|null} log
 * @param {{ history?: object[] }} [opts]
 */
export async function clickApplyOrHandoff(page, snap, context, log = null, opts = {}) {
  const history = opts.history || [];
  const fp = pageFingerprint(snap);
  const priorTotal = countApplyCtaAttempts(history, fp);
  const priorUnverified = countUnverifiedAttempts(history, fp, "click_apply");

  if (priorUnverified >= MAX_UNVERIFIED_APPLY_CTA) {
    log?.layer?.(
      "apply_cta",
      `unverified Apply CTA cap (${priorUnverified}) — handoff`,
      "warn",
    );
    return {
      ...toTransitionResult({
        clicked: false,
        before: snap,
        after: snap,
        handoff: true,
        reason: "apply_cta_unverified_cap",
      }),
      source: "cap",
      handoff: true,
      snap,
    };
  }

  const finish = async (clicked, source, text = "") => {
    await humanPause(600, 1000);
    const after = await inspectPage(page).catch(() => snap);
    const transition = toTransitionResult({ clicked, before: snap, after });
    if (clicked && !transition.advanced) {
      log?.layer?.(
        "apply_cta",
        `clicked but no advance (${transition.reason}) source=${source}`,
        "warn",
      );
    }
    return {
      ...transition,
      source,
      text,
      snap: after,
      handoff: false,
    };
  };

  const cta = await resolveApplyCta(page, snap, context);
  if (cta?.source === "snap" && cta.candidate) {
    log?.layer?.("apply_cta", `clicking snap CTA "${String(cta.text).slice(0, 40)}"`, "info");
    const ok = await clickCandidate(page, cta.candidate, log, "apply_cta", "entry");
    if (ok) return finish(true, "snap", cta.text);
  }

  if (cta?.source === "live" && cta.text) {
    log?.layer?.("apply_cta", `clicking live CTA "${String(cta.text).slice(0, 40)}"`, "info");
    const clicked = await page
      .evaluate((want) => {
        const wantRe = new RegExp(`^${want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
        const nodes = [
          ...document.querySelectorAll('a, button, [role="button"], input[type="submit"]'),
        ];
        for (const el of nodes) {
          const text = String(el.innerText || el.value || el.getAttribute("aria-label") || "")
            .replace(/\s+/g, " ")
            .trim();
          if (!wantRe.test(text) && text.toLowerCase() !== want.toLowerCase()) continue;
          el.click();
          return true;
        }
        return false;
      }, cta.text)
      .catch(() => false);
    if (clicked) return finish(true, "live", cta.text);
  }

  // One Stagehand call with scoped job-detail instruction — never burn the budget.
  if (priorTotal === 0 && canUseStagehand(context).ok) {
    const instruction =
      'You are on a single job detail page. Click the main "Apply", "Apply for this job", "Apply to role", or "Reach out" button. ' +
      "Do not navigate to other listings, job boards, or open new tabs.";
    log?.layer?.("apply_cta", "Stagehand scoped Apply CTA (one shot)", "info");
    const sh = await attemptStagehandAct(page, context, { instruction, log }).catch(() => ({
      ok: false,
    }));
    const result = await finish(Boolean(sh?.ok), "stagehand");
    result.stagehand = true;
    // Stagehand "ok" without advance is still stuck — do not invent progress.
    return result;
  }

  log?.layer?.("apply_cta", "no Apply CTA found — handoff", "warn");
  return {
    ...toTransitionResult({
      clicked: false,
      before: snap,
      after: snap,
      handoff: true,
      reason: priorTotal > 0 ? "apply_cta_exhausted" : "no_apply_cta_found",
    }),
    handoff: true,
    snap,
  };
}

/**
 * Zero-field job detail that still needs an Apply click.
 * @param {object} snap
 */
export function needsApplyCtaDiscovery(snap) {
  if (!snap) return false;
  const fields = snap.fieldCount || 0;
  const customs = (snap.customControls || []).length;
  if (fields > 0 || customs > 0) return false;
  if (snap.authForm || snap.signupForm || (snap.passwordFieldCount || 0) > 0) return false;
  const kind = String(snap.pageKind || "");
  if (["listing", "content", "unknown", "modal"].includes(kind)) return true;
  if ((snap.entryCount || 0) > 0) return true;
  // Job detail URLs with prose body and no form.
  const url = String(snap.url || "");
  if (/\/jobs?\/\d+|\/job\/|\/positions?\//i.test(url) && (snap.bodyTextLength || 0) > 400) {
    return true;
  }
  return false;
}

export { HIGH_CONFIDENCE_TEXTS };
