/**
 * Merge Stagehand observe() candidates into the action catalog for ranking.
 */
import { canUseStagehand, observeStagehandCandidates } from "./stagehandAdapter.js";
import { buildStagehandInstruction } from "./stagehandPolicy.js";

/**
 * @param {import('./actionCatalog.js').CatalogAction[]} catalog
 * @param {import('playwright').Page|null} page
 * @param {object} snap
 * @param {object} classification
 * @param {object[]} history
 * @param {object} context
 * @param {object|null} log
 */
export async function enrichCatalogWithStagehandObserve(
  catalog,
  page,
  snap,
  classification,
  history,
  context,
  log = null,
) {
  if (!page || !Array.isArray(catalog)) return catalog || [];
  if (!canUseStagehand(context).ok) return catalog;

  // Skip observe on soft OTP / auth — DOM catalog already decides.
  if (["enter_otp", "auth", "signup", "blocked", "verify_email"].includes(classification?.step)) {
    return catalog;
  }

  // Only observe when entry/ambiguous or catalog is sparse / Stagehand-leaning.
  const needsObserve =
    classification?.step === "entry" ||
    classification?.step === "ambiguous" ||
    (snap?.entryCount || 0) === 0 ||
    catalog.some((a) => a.type === "stagehand_act");
  if (!needsObserve) return catalog;

  const instruction = buildStagehandInstruction(snap, classification, history, context);
  const observed = await observeStagehandCandidates(page, context, { instruction, log });
  if (!observed.ok || !observed.candidates?.length) return catalog;

  const merged = [...catalog];
  let i = 0;
  for (const cand of observed.candidates.slice(0, 5)) {
    const desc = String(cand.description || cand.method || cand.selector || "observed action").slice(0, 120);
    const score = 70 - i * 4;
    merged.push({
      id: `stagehand_observe_${i}`,
      type: "stagehand_act",
      score,
      reason: `stagehand observe: ${desc}`,
      instruction: desc,
      stagehandAction: cand,
      step: classification?.step || "ambiguous",
      source: "stagehand-observe",
    });
    i += 1;
  }

  // Prefer named DOM entry over free-form observe when both exist.
  const topEntry = snap?.entryCandidates?.[0];
  if (topEntry && /apply to role|apply for (the|this) job/i.test(String(topEntry.text || ""))) {
    for (const a of merged) {
      if (a.type === "click_apply") a.score = Math.max(a.score, 88);
      if (a.source === "stagehand-observe" && /\bapply\b/i.test(a.reason || "") && !/role|for (the|this) job/i.test(a.reason || "")) {
        a.score -= 20;
      }
    }
  }

  merged.sort((a, b) => b.score - a.score);
  return merged;
}
