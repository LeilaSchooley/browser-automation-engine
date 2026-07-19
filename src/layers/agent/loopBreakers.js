/**
 * Post-decide loop breakers — override thrashing dismiss / continue / board-signup plans.
 * Behavior-identical extract from automationAgent.
 */
import {
  dismissLoopStalled,
  continueLoopStalled,
  hasUnfilledApplicationFields,
  shouldBlockBoardSignupAfterLeave,
} from "../../heuristics.js";
import { looksLikeBoardSignupOnboarding } from "../../platformOnboarding.js";

/**
 * Apply dismiss / continue / board-signup overrides in the same order as the loop.
 * @returns {{ plan: object, reason: string } | null}
 */
export function applyLoopBreakers({
  plan,
  snap,
  history,
  fillResult,
  context = null,
} = {}) {
  let next = plan;
  let applied = false;

  // Loop breaker: repeated dismiss without progress while Apply is visible → click Apply.
  if (
    next?.type === "dismiss_overlay" &&
    dismissLoopStalled(history, 2) &&
    (snap.entryCount || 0) > 0
  ) {
    const top = snap.entryCandidates?.[0];
    next = {
      type: "click_apply",
      reason: `dismiss loop broken — force ${top?.text || "Apply"}`,
      source: "loop-breaker",
      targetCandidate: top || null,
    };
    applied = true;
  }

  // Loop breaker: Next/Continue thrashing (esp. board onboard wizards) with no fills.
  if (next?.type === "click_continue" && continueLoopStalled(history, fillResult, 3)) {
    if (looksLikeBoardSignupOnboarding(snap)) {
      next = {
        type: "wait_user",
        reason: "continue loop on board signup onboarding — handoff",
        source: "loop-breaker",
      };
    } else if (hasUnfilledApplicationFields(snap, fillResult)) {
      next = {
        type: "smart_fill",
        reason: "continue loop broken — fill before Next",
        source: "loop-breaker",
      };
    } else if ((context?.submitUrl || context?.startUrl) && !history.some((h) => h.action === "nav_recovery")) {
      next = {
        type: "nav_recovery",
        reason: "continue loop broken — recover navigation",
        source: "loop-breaker",
      };
    } else {
      next = {
        type: "wait_user",
        reason: "continue loop stalled — no application progress",
        source: "loop-breaker",
      };
    }
    applied = true;
  }

  // Loop breaker: Sign Up after board leave re-enters onboard.
  if (next?.type === "click_signup" && shouldBlockBoardSignupAfterLeave(history, snap)) {
    if ((snap.entryCount || 0) > 0) {
      next = {
        type: "click_apply",
        reason: "board leave done — force Apply instead of Sign Up",
        source: "loop-breaker",
        targetCandidate: snap.entryCandidates?.[0] || null,
      };
    } else {
      next = {
        type: "wait_user",
        reason: "board leave done — Sign Up would re-enter onboard (handoff)",
        source: "loop-breaker",
      };
    }
    applied = true;
  }

  if (!applied) return null;
  return { plan: next, reason: next.reason };
}
