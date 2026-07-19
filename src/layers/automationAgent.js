import { getRuntime, getSettings } from "../runtime.js";
import { isCloudflarePage, waitForCloudflareClear } from "../cloudflare.js";
import {
  detectCaptcha,
  waitForCaptchaClear,
  looksLikeCaptchaReason,
} from "../captchaDetect.js";
import { humanPause, humanPauseInterruptible } from "../human.js";
import { uploadDiscoveredFile } from "./domActions.js";
import {
  inspectPage,
  logPageSnapshot,
  pageFingerprint,
} from "./formDiscovery.js";
import { waitForApplySurface } from "./pageReady.js";
import { allowsHostHop } from "../host.js";
import {
  looksLikeDeadApplyDestination,
  looksLikeAggregatorTrap,
  shouldBlockApplyNavigation,
  isEmployerAtsUrl,
} from "./applyUrlSafety.js";
import { gotoWithCloudflareRetry } from "../cloudflare.js";
import {
  isStuck,
  uploadAlreadySucceeded,
  boardLeaveSucceeded,
} from "../heuristics.js";
import { RecoveryTracker, runStuckFillRecovery } from "./recovery/index.js";
import { appendRunHistory, trailFingerprint } from "../runHistory.js";
import { hasUnfilledApplicationControls } from "../fillApplicationAnswers.js";
import {
  attemptApplicationControlsStagehand,
  buildStagehandInstruction,
  shouldPreferStagehand,
} from "./stagehandPolicy.js";
import { fillCustomControls } from "../fillCustomControls.js";
import { looksLikeHardGate, looksLikeAuthForm } from "./authActions.js";
import { looksLikeSignupForm } from "./signupActions.js";
import {
  currentStepIncomplete,
  looksLikeSteppedForm,
  planAfterContinue,
} from "./steppedForm.js";
import { recordSiteLearning, loadSiteLearnings, affordanceSkillFromAct } from "../siteLearnings.js";
import { recordCachedPlan } from "./actionPlanCache.js";
import { recordEngineEvent, captureDebugScreenshot } from "../observability.js";
import { buildPagePerception, refreshSnapIfNeeded, computePageDiff } from "./pagePerception.js";
import { recordLearningsFromRun } from "../learningRecorder.js";
import { isBrowserSessionGone, raceUntilGone, isBrowserClosedError } from "../pageAlive.js";
import {
  enrichContextWithLearnings,
  recoverFromWrongNavigation,
  shouldAttemptNavRecovery,
} from "./navigationRecovery.js";
import { attemptObstacleRecovery } from "./obstacleActions.js";
import { attemptVisionFallback } from "./visionFallback.js";
import { attemptCaptchaSolve } from "./captchaSolve.js";
import { executePlan } from "./executePlan.js";
import {
  attemptSemanticRecovery,
  attemptFinalRecovery,
} from "./semanticRecovery.js";
import { tryAdoptFormIframe } from "./iframeAdopt.js";
import { decideWithActionBrain } from "./actionBrain.js";
import { applyLoopBreakers } from "./agent/loopBreakers.js";
import {
  scoreStepProgress,
  filterHallucinatedDone,
  computeMechanicalProgress,
  evaluateReadyForReview,
} from "./agent/progressAndDone.js";
import { applyTabHygieneAfterClick, applyHostHop } from "./agent/tabAndHop.js";

export async function decideNextAction(snap, fillResult, history, context, page = null) {
  return decideWithActionBrain(snap, fillResult, history, context, page);
}

/**
 * Dynamic automation agent — observe → action catalog → act loop.
 */
export async function runAutomationAgent(page, context, log, { url, sessionId = null, shouldStop = null, submitUrl = null } = {}) {
  const settings = getSettings();
  const maxSteps = Math.max(3, settings.agent_max_steps);
  const objectiveMode = settings.objective_mode !== false;
  const agentContext = enrichContextWithLearnings(
    {
      ...context,
      startUrl: url,
      submitUrl: submitUrl || context?.submitUrl,
      targetHost: context?.targetHost,
    },
    (() => {
      try {
        return new URL(submitUrl || url || "").hostname;
      } catch {
        return "";
      }
    })(),
  );
  const history = [];
  const recoveryTracker = new RecoveryTracker({ maxPerAction: 3, maxGlobal: maxSteps + 4 });
  let hasUsedStagehand = false;
  let fillResult = { filled: [], unfilled: [], unfilled_count: 0, ai_filled: 0 };
  let prepActions = [];
  let bestScore = 0;
  let lastSnap = null;
  let lastClassification = null;

  let recoveryRounds = 0;
  const maxRecoveryRounds = 3;
  let consecutiveNoProgress = 0;
  const maxNoProgress = Math.max(2, settings.agent_max_no_progress || 4);

  const hopAllowed = allowsHostHop(agentContext);
  const maxHostHops = 4;
  const maxAggregatorHops = 2;
  let hostHops = 0;
  let aggregatorHops = 0;
  let knownPages = new Set();
  try {
    knownPages = new Set(page.context().pages());
  } catch {
    /* non-Playwright page in tests */
  }

  log.step("agent", `Dynamic agent (max ${maxSteps} steps, affordance-driven)…`);

  /** Current handle closed after a tab hop ≠ session dead — prefer ATS / any live sibling. */
  const recoverWorkingPage = () => {
    try {
      const ctx = page?.context?.();
      const pages = (ctx?.pages?.() || []).filter((p) => {
        try {
          return p && !p.isClosed();
        } catch {
          return false;
        }
      });
      if (!pages.length) return null;
      const ats = [...pages].reverse().find((p) => {
        try {
          return isEmployerAtsUrl(p.url());
        } catch {
          return false;
        }
      });
      return ats || pages[pages.length - 1] || null;
    } catch {
      return null;
    }
  };

  const sessionGone = () => {
    try {
      if (!isBrowserSessionGone(page)) return false;
      const live = recoverWorkingPage();
      if (live) {
        if (live !== page) {
          log.layer("agent", `working page closed after hop — adopted live tab ${(() => {
            try {
              return live.url();
            } catch {
              return "(unknown)";
            }
          })()}`, "warn");
          page = live;
        }
        return false;
      }
      return true;
    } catch {
      const live = recoverWorkingPage();
      if (live) {
        page = live;
        return false;
      }
      return true;
    }
  };
  // User stop / CDP disconnect only — do not treat a closed hop tab as stop.
  const stopRequested = () => Boolean(shouldStop?.()) || sessionGone();
  /** After Continue/Next opens a new wizard panel — force fill before another advance. */
  let pendingSteppedFill = null;

  for (let step = 1; step <= maxSteps; step++) {
    if (sessionGone()) {
      log.layer("agent", "browser closed — exiting agent loop", "warn");
      history.push({
        step,
        action: "stopped",
        ok: true,
        fingerprint: pageFingerprint(lastSnap || {}),
        progress: false,
        reason: "browser_closed",
      });
      const err = new Error("Browser closed");
      err.code = "BROWSER_CLOSED";
      throw err;
    }
    if (Boolean(shouldStop?.())) {
      log.layer("agent", "stop requested — exiting agent loop", "info");
      history.push({ step, action: "stopped", ok: true, fingerprint: pageFingerprint(lastSnap || {}), progress: false });
      break;
    }

    if (await isCloudflarePage(page)) {
      log.layer("agent", "cloudflare — waiting", "warn");
      await waitForCloudflareClear(page, sessionId);
    }

    {
      const challenge = await detectCaptcha(page).catch(() => ({ detected: false }));
      if (challenge.detected) {
        log.layer("agent", `captcha — ${challenge.reason} — waiting for manual solve`, "warn");
        const cleared = await waitForCaptchaClear(page, sessionId, { initial: challenge });
        history.push({
          step,
          action: cleared ? "captcha_wait" : "wait_user",
          applyStep: "blocked",
          ok: cleared,
          progress: cleared,
          reason: challenge.reason,
        });
        if (!cleared) break;
        consecutiveNoProgress = 0;
        continue;
      }
    }

    let snap = await inspectPage(page);
    const perception = await buildPagePerception(page, snap).catch(() => null);
    if (perception?.enabled) snap._perception = perception;
    recordEngineEvent("agent_step", { step, url: snap.url, pageKind: snap.pageKind, perceptionDiff: perception?.diff });
    lastSnap = snap;

    const deadDestination = looksLikeDeadApplyDestination(snap);
    if (deadDestination.dead) {
      log.layer("agent", `dead apply destination — ${deadDestination.reason}`, "warn");
      history.push({
        step,
        action: "wait_user",
        applyStep: "blocked",
        ok: true,
        fingerprint: pageFingerprint(snap),
        progress: false,
        reason: deadDestination.reason,
      });
      break;
    }

    const aggregatorTrap = looksLikeAggregatorTrap(snap, history);
    if (aggregatorTrap.trapped) {
      log.layer("agent", `aggregator trap — ${aggregatorTrap.reason}`, "warn");
      history.push({
        step,
        action: "wait_user",
        applyStep: "blocked",
        ok: true,
        fingerprint: pageFingerprint(snap),
        progress: false,
        reason: aggregatorTrap.reason,
      });
      break;
    }

    const iframeAdopt = await tryAdoptFormIframe(page, snap, log);
    if (iframeAdopt.adopted) {
      page = iframeAdopt.page;
      snap = await waitForApplySurface(page, log, { timeoutMs: 15000 });
      lastSnap = snap;
      history.push({
        step,
        action: "iframe_adopt",
        ok: true,
        fingerprint: pageFingerprint(snap),
        progress: true,
        source: "iframe-adopt",
      });
      consecutiveNoProgress = 0;
    }

    let plan;
    let classification;
    let decision;
    if (pendingSteppedFill) {
      plan = pendingSteppedFill;
      classification = {
        step: "form",
        confidence: "high",
        reason: plan.reason,
      };
      decision = { path: "stepped-form", reason: plan.reason };
      pendingSteppedFill = null;
      log.layer("agent", plan.reason, "info");
    } else {
      ({ plan, classification, decision } = await decideNextAction(
        snap,
        fillResult,
        history,
        agentContext,
        page,
      ));
    }
    lastClassification = classification;

    // Stepped form: never Continue while the current panel still has empty fields.
    if (
      plan?.type === "click_continue" &&
      looksLikeSteppedForm(snap) &&
      currentStepIncomplete(snap, fillResult)
    ) {
      plan = {
        type: "smart_fill",
        reason: "stepped form — fill current step before Continue",
        source: "stepped-form",
      };
      decision = { path: "stepped-form", reason: plan.reason };
      log.layer("agent", plan.reason, "info");
    }

    const broken = applyLoopBreakers({
      plan,
      snap,
      history,
      fillResult,
      context: agentContext,
    });
    if (broken) {
      plan = broken.plan;
      decision = { path: "loop-breaker", reason: broken.reason };
      log.layer("agent", broken.reason, "warn");
    }

    // RecoveryTracker — escalate repeating actions
    if (plan?.type) {
      const fp = pageFingerprint(snap);
      recoveryTracker.record(plan.type, fp);
      if (plan.type === "stagehand_act") hasUsedStagehand = true;
      const esc = recoveryTracker.escalate(plan.type, fp, { hasUsedStagehand });
      const stagehandAllowed = shouldPreferStagehand(
        snap,
        classification || { step: "ambiguous", confidence: "low" },
        history,
        agentContext,
        fillResult,
      );
      if (
        esc === "stagehand" &&
        stagehandAllowed &&
        plan.type !== "stagehand_act" &&
        plan.type !== "wait_user"
      ) {
        plan = {
          type: "stagehand_act",
          reason: `recovery: ${plan.type} looping — Stagehand escalate`,
          source: "recovery-tracker",
          instruction: buildStagehandInstruction(snap, classification || { step: plan.type === "click_apply" ? "entry" : classification?.step }, history, context, {
            forceApply: plan.type === "click_apply" || classification?.step === "entry",
          }),
        };
        hasUsedStagehand = true;
        decision = { path: "recovery-tracker", reason: plan.reason };
        log.layer("agent", plan.reason, "warn");
      } else if (esc === "stagehand" && !stagehandAllowed && plan.type !== "wait_user") {
        plan = {
          type: "wait_user",
          reason: `recovery: ${plan.type} looping on protected auth/signup flow — handoff`,
          source: "recovery-tracker",
        };
        decision = { path: "recovery-tracker", reason: plan.reason };
        log.layer("agent", plan.reason, "warn");
      } else if (esc === "wait_user" && plan.type !== "wait_user") {
        plan = {
          type: "wait_user",
          reason: `recovery: ${plan.type} exhausted — handoff`,
          source: "recovery-tracker",
        };
        decision = { path: "recovery-tracker", reason: plan.reason };
        log.layer("agent", plan.reason, "warn");
      }
    }

    if (decision?.path) {
      recordEngineEvent("agent_decide", {
        path: decision.path,
        step: classification?.step,
        confidence: classification?.confidence,
        planType: plan?.type,
        reason: decision.reason?.slice(0, 200),
      });
    }

    logPageSnapshot(log, snap, "agent", classification);

    const scored = scoreStepProgress(snap, fillResult, bestScore);
    const score = scored.score;
    bestScore = scored.bestScore;

    // "done" must be earned: either the classifier reached review, or we actually
    // filled fields on something that looks like an apply form. An AI plan saying
    // "done" on an untouched listing page is a hallucination — keep working.
    if (plan?.type === "done") {
      const filtered = filterHallucinatedDone(plan, classification, fillResult, snap);
      if (!filtered) {
        log.layer("agent", `ignoring done (${plan.reason}) — no filled apply form yet, continuing`, "warn");
        plan = null;
      }
    }

    if (!plan && objectiveMode && recoveryRounds < maxRecoveryRounds) {
      recoveryRounds += 1;
      const obstacle = await attemptObstacleRecovery(page, snap, log);
      if (obstacle.hardStop) {
        if (looksLikeCaptchaReason(obstacle.reason)) {
          const solved = await attemptCaptchaSolve(page, snap, log);
          if (solved.ok) {
            history.push({ step, action: "captcha_solve", ok: true, progress: true });
            continue;
          }
          log.layer("agent", `captcha hard gate — waiting for manual solve (${obstacle.reason})`, "warn");
          const cleared = await waitForCaptchaClear(page, sessionId, {
            initial: { reason: obstacle.reason, source: "hard_gate" },
          });
          history.push({
            step,
            action: cleared ? "captcha_wait" : "wait_user",
            applyStep: "blocked",
            ok: cleared,
            progress: cleared,
            reason: obstacle.reason,
          });
          if (cleared) {
            consecutiveNoProgress = 0;
            continue;
          }
          break;
        }
        log.layer("agent", `hard stop: ${obstacle.reason}`, "warn");
        history.push({ step, action: "wait_user", applyStep: "blocked", ok: true, progress: false });
        break;
      }
      if (obstacle.ok) {
        history.push({ step, action: "clear_obstacle", ok: true, progress: true, source: obstacle.action });
        await humanPause(500, 900);
        continue;
      }
      if (obstacle.action === "needs_auth" || looksLikeAuthForm(snap) || looksLikeSignupForm(snap)) {
        const preferSignup =
          looksLikeSignupForm(snap) ||
          classification?.step === "signup" ||
          classification?.step === "signup_entry";
        plan = {
          type: preferSignup ? "auth_signup" : "auth_login",
          reason: "recovery — auth wall after empty plan",
          source: "obstacle-recovery",
        };
      } else {
        const visionPlan = await attemptVisionFallback(
          page,
          agentContext,
          snap,
          history,
          fillResult,
          classification,
          log,
        );
        if (visionPlan) {
          plan = visionPlan;
        } else {
          log.layer("agent", "no action — recovery exhausted this round", "warn");
          if (recoveryRounds >= maxRecoveryRounds) break;
          await humanPause(800, 1200);
          continue;
        }
      }
    }

    if (!plan) {
      const finalTry = await attemptFinalRecovery(page, snap, history, fillResult, agentContext, log, {
        url,
        sessionId,
      });
      if (finalTry.recovered) {
        if (finalTry.fillResult) fillResult = finalTry.fillResult;
        lastSnap = finalTry.snap || snap;
        history.push({
          step,
          action: finalTry.plan?.type || "recovery",
          ok: true,
          fingerprint: pageFingerprint(lastSnap),
          progress: true,
          source: "end-state-recovery",
        });
        await humanPause(900, 1600);
        continue;
      }
      const stuck = isStuck(history, snap);
      log.layer(
        "agent",
        stuck ? "stuck — no valid action for current step" : "no action for current step — stopping",
        stuck ? "warn" : "debug",
      );
      break;
    }

    if (plan.type === "done") {
      log.layer("agent", `stop: done — ${plan.reason}`, "info");
      history.push({
        step,
        action: plan.type,
        applyStep: classification.step,
        ok: true,
        fingerprint: pageFingerprint(snap),
        progress: false,
      });
      break;
    }

    if (plan.type === "wait_user") {
      const captchaReason =
        looksLikeCaptchaReason(plan.reason) ||
        looksLikeCaptchaReason(classification?.reason) ||
        looksLikeCaptchaReason(looksLikeHardGate(snap).reason);
      if (captchaReason) {
        log.layer("agent", `captcha wait_user — waiting for manual solve (${plan.reason || classification?.reason})`, "warn");
        const cleared = await waitForCaptchaClear(page, sessionId, {
          initial: { reason: plan.reason || classification?.reason || "CAPTCHA / human verification", source: "wait_user" },
        });
        history.push({
          step,
          action: cleared ? "captcha_wait" : "wait_user",
          applyStep: "blocked",
          ok: cleared,
          fingerprint: pageFingerprint(snap),
          progress: cleared,
          reason: plan.reason || classification?.reason,
        });
        if (cleared) {
          consecutiveNoProgress = 0;
          continue;
        }
        break;
      }
      const hard = classification.hardStop || looksLikeHardGate(snap).hard;
      if (objectiveMode && !hard && recoveryRounds < maxRecoveryRounds) {
        recoveryRounds += 1;
        log.layer("agent", `soft blocked — trying obstacle recovery (${plan.reason})`, "warn");
        const obstacle = await attemptObstacleRecovery(page, snap, log);
        if (obstacle.ok) {
          history.push({ step, action: "clear_obstacle", ok: true, progress: true });
          continue;
        }
        if (looksLikeSignupForm(snap) || looksLikeAuthForm(snap)) {
          const preferSignup =
            looksLikeSignupForm(snap) ||
            classification?.step === "signup" ||
            classification?.step === "signup_entry";
          plan = {
            type: preferSignup ? "auth_signup" : "auth_login",
            reason: "soft blocked → auth",
            source: "soft-blocked",
          };
        } else {
          history.push({ step, action: "wait_user", ok: true, progress: false });
          break;
        }
      } else {
        log.layer("agent", `stop: wait_user — ${plan.reason}`, "info");
        history.push({
          step,
          action: plan.type,
          applyStep: classification.step,
          ok: true,
          fingerprint: pageFingerprint(snap),
          progress: false,
        });
        break;
      }
    }

    if (plan.type === "wait") {
      plan.type = "wait_load";
      plan.reason = plan.reason || "AI wait for page";
    }

    log.step("agent", `Step ${step}/${maxSteps}: ${plan.type}`);
    log.layer(
      "agent",
      `step ${step}/${maxSteps}: ${plan.type} (classified=${classification.step}, conf=${classification.confidence}, via=${decision?.path || plan.source || "?"}) — ${plan.reason}`,
      "info",
    );

    const fpBefore = pageFingerprint(snap);
    const filledBefore = fillResult.filled?.length || 0;
    let executed;
    try {
      // Mid-step Stagehand/Playwright can hang after AdsPower/CDP dies — abort the await.
      executed = await raceUntilGone(
        executePlan(page, plan, {
          snap,
          context: agentContext,
          log,
          url,
          sessionId,
          fillResult,
          history,
          classification,
          shouldStop: () => Boolean(shouldStop?.()) || sessionGone(),
        }),
        { isGone: sessionGone, intervalMs: 500 },
      );
    } catch (stepErr) {
      if (isBrowserClosedError(stepErr) || stepErr?.code === "BROWSER_CLOSED" || sessionGone()) {
        log.layer("agent", "browser closed mid-step — exiting agent loop", "warn");
        history.push({
          step,
          action: "stopped",
          ok: true,
          fingerprint: pageFingerprint(lastSnap || snap || {}),
          progress: false,
          reason: "browser_closed",
        });
        const err = new Error("Browser closed");
        err.code = "BROWSER_CLOSED";
        throw err;
      }
      throw stepErr;
    }

    let ok = executed.ok;
    const entryKeyForHistory = executed.entryKey || "";
    if (executed.fillResult) fillResult = executed.fillResult;
    if (executed.snap) lastSnap = executed.snap;
    if (executed.prepActions?.length) prepActions.push(...executed.prepActions);
    const stepLearnings = executed.learnings;

    // Apply links with target=_blank open the next hop in a new tab — follow it.
    // Only adopt when the current page stayed put; if it navigated, the flow
    // continued here and any stray popup is likely an ad.
    {
      const tabbed = await applyTabHygieneAfterClick({
        page,
        plan,
        snap,
        knownPages,
        log,
        step,
        ok,
      });
      page = tabbed.page;
      ok = tabbed.ok;
      knownPages = tabbed.knownPages;
    }

    let snapAfter = await refreshSnapIfNeeded(page, snap, inspectPage, {
      force: ["click_apply", "click_modal", "click_continue", "click_signup", "click_signin", "act", "smart_fill", "upload_resume"].includes(plan.type),
    });
    lastSnap = snapAfter;

    // Wizard advanced → queue fill of the new step on the next loop iteration.
    if (ok && (plan.type === "click_continue" || plan.type === "click_modal")) {
      const follow = planAfterContinue(snap, snapAfter, fillResult);
      if (follow) {
        pendingSteppedFill = follow;
        log.layer("agent", follow.reason, "info");
      }
    }

    // Failed Continue / CTA with no DOM progress — often an invisible captcha overlay
    // (Playwright: "<div></div> … intercepts pointer events"). Wait for manual solve.
    if (
      !ok &&
      ["click_continue", "click_modal", "click_apply", "act", "stagehand_act"].includes(plan.type)
    ) {
      const challenge = await detectCaptcha(page, {
        snap: snapAfter,
        suspectPointerBlock: true,
      }).catch(() => ({ detected: false }));
      if (challenge.detected) {
        log.layer(
          "agent",
          `captcha after failed ${plan.type} — ${challenge.reason} — waiting for manual solve`,
          "warn",
        );
        const cleared = await waitForCaptchaClear(page, sessionId, {
          initial: challenge,
          keepSuspectOverlay: challenge.source === "overlay",
        });
        history.push({
          step,
          action: cleared ? "captcha_wait" : "wait_user",
          applyStep: "blocked",
          ok: cleared,
          fingerprint: pageFingerprint(snapAfter),
          progress: cleared,
          reason: challenge.reason,
        });
        if (cleared) {
          consecutiveNoProgress = 0;
          continue;
        }
        break;
      }
    }

    const perceptionDiff =
      snap._perception && snapAfter._perception
        ? computePageDiff(snap._perception, snapAfter._perception)
        : null;
    let progressed = computeMechanicalProgress({
      snapAfter,
      fpBefore,
      fillResult,
      score,
      perceptionDiff,
      pageFingerprint,
    });

    // Clicked apply but nothing changed (overlay swallowed the click, JS-guarded
    // link, slow interstitial): navigate straight to the candidate's href.
    if (plan.type === "click_apply" && ok && !progressed) {
      const href = executed.entryCandidate?.href || "";
      let resolved = "";
      try {
        if (href && !/^(javascript:|#|mailto:)/i.test(href)) {
          resolved = new URL(href, snap.url || url).href;
        }
      } catch {
        resolved = "";
      }
      if (resolved && resolved !== (snapAfter.url || "")) {
        const block = shouldBlockApplyNavigation(resolved, snap.url || url);
        if (block.block) {
          log.layer("agent", `skipping toxic apply href — ${block.reason}`, "warn");
          ok = false;
        } else {
          log.layer("agent", `entry click had no effect — navigating directly to ${resolved.slice(0, 120)}`, "warn");
          try {
            await gotoWithCloudflareRetry(page, resolved, { sessionId });
            snapAfter = await waitForApplySurface(page, log, { timeoutMs: 15000 });
            lastSnap = snapAfter;
            progressed = pageFingerprint(snapAfter) !== fpBefore;
          } catch {
            /* keep original state */
          }
        }
      }
    }

    // Redirect chains legitimately change hosts; retarget so entry ranking and
    // learnings follow the chain instead of fighting it.
    {
      const hop = applyHostHop({
        hopAllowed,
        snapAfter,
        agentContext,
        hostHops,
        aggregatorHops,
        maxHostHops,
        maxAggregatorHops,
        log,
      });
      hostHops = hop.hostHops;
      aggregatorHops = hop.aggregatorHops;
      if (hop.stopReason === "aggregator_chain") {
        history.push({
          step,
          action: "wait_user",
          applyStep: "blocked",
          ok: true,
          fingerprint: pageFingerprint(snapAfter),
          progress: false,
          reason: "job listing aggregator chain — no real apply form",
        });
        break;
      }
      if (hop.stop) break;
    }

    if (ok && shouldAttemptNavRecovery(plan, snapAfter, agentContext, history)) {
      const recovery = await recoverFromWrongNavigation(page, snapAfter, agentContext, history, log, {
        sessionId,
      });
      if (recovery.recovered) {
        log.layer("agent", `nav recovered via ${recovery.action}`, "info");
        lastSnap = recovery.snap || snapAfter;
        history.push({
          step,
          action: "nav_recovery",
          applyStep: "nav_recovery",
          ok: true,
          fingerprint: pageFingerprint(lastSnap),
          progress: true,
          source: recovery.action,
        });
        if (recovery.entryKey) {
          recordSiteLearning(agentContext.targetHost || lastSnap.hostname, {
            entryText: recovery.snap?.entryCandidates?.[0]?.text,
            entryHref: recovery.url || lastSnap.url,
          });
        }
        await humanPause(700, 1200);
        continue;
      }
      ok = false;
      if (entryKeyForHistory && agentContext.targetHost) {
        try {
          const hosts = loadSiteLearnings();
          const key = agentContext.targetHost.replace(/^www\./, "");
          const prev = hosts[key]?.avoidEntryKeys || [];
          recordSiteLearning(key, {
            avoidEntryKeys: [...new Set([...prev, entryKeyForHistory])],
          });
        } catch {
          /* ignore */
        }
      }
    }

    let progressReason = progressed ? "mechanical" : "no DOM change";
    let progressSource = "mechanical";
    let verdict = null;
    const { validateAction } = getRuntime();
    if (typeof validateAction === "function") {
      try {
        verdict = await validateAction({
          plan,
          snapBefore: snap,
          snapAfter,
          fillResult,
          mechanicalProgress: progressed,
          actorOk: ok,
          history,
          context: agentContext,
          classification,
          filledBefore,
          page,
        });
        if (verdict && typeof verdict.progressed === "boolean") {
          if (verdict.progressed !== progressed) {
            log.layer(
              "agent",
              `validator override: mechanical=${progressed} → semantic=${verdict.progressed} (${verdict.reason || "?"})`,
              "warn",
            );
          }
          progressed = verdict.progressed;
          progressReason = verdict.reason || progressReason;
          progressSource = verdict.source || "validator";
        }
      } catch (err) {
        log.layer("agent", `validator error: ${err?.message || err}`, "warn");
      }
    }

    // Validator says "no real progress" — try to recover intelligently before counting toward stuck.
    if (!progressed && ok && verdict && progressSource === "validator") {
      const recovery = await attemptSemanticRecovery(page, snapAfter, {
        verdict,
        history,
        lastPlan: plan,
        log,
        url,
        sessionId,
        fillResult,
        context: agentContext,
      });
      if (recovery.ok) {
        if (recovery.fillResult) fillResult = recovery.fillResult;
        snapAfter = recovery.snap || (await inspectPage(page));
        lastSnap = snapAfter;
        progressed = true;
        progressReason = `recovered: ${recovery.plan?.reason || verdict.reason}`;
        progressSource = "semantic-recovery";
        history.push({
          step,
          action: plan.type,
          applyStep: classification.step,
          ok,
          entryKey: entryKeyForHistory || undefined,
          fromFingerprint: fpBefore,
          fingerprint: pageFingerprint(snapAfter),
          progress: false,
          progressReason: verdict.reason,
          progressSource: "validator",
          source: plan.source || "step-classifier",
          validatorRejected: true,
        });
        history.push({
          step,
          action: recovery.plan?.type || "semantic_recovery",
          applyStep: recovery.plan?.type || "recovery",
          ok: true,
          fingerprint: pageFingerprint(snapAfter),
          progress: true,
          progressReason: recovery.plan?.reason,
          progressSource: "semantic-recovery",
          source: recovery.plan?.source || "semantic-recovery",
        });
        if (stepLearnings && agentContext.targetHost) {
          try {
            const patch = {};
            if (stepLearnings.authSelectors) patch.authSelectors = stepLearnings.authSelectors;
            if (stepLearnings.modalSelector) patch.modalSelectors = [stepLearnings.modalSelector];
            if (stepLearnings.controlSkills) patch.controlSkills = stepLearnings.controlSkills;
            if (stepLearnings.affordanceSkills) patch.affordanceSkills = stepLearnings.affordanceSkills;
            if (Object.keys(patch).length) recordSiteLearning(agentContext.targetHost, patch);
          } catch {
            /* ignore */
          }
        }
        await humanPause(900, 1600);
        continue;
      }
    }

    history.push({
      step,
      action: plan.type,
      applyStep: classification.step,
      ok,
      entryKey: entryKeyForHistory || undefined,
      entryText: executed.entryCandidate?.text || plan.targetCandidate?.text || undefined,
      entryHref: executed.entryCandidate?.href || plan.targetCandidate?.href || undefined,
      fromFingerprint: fpBefore,
      fingerprint: pageFingerprint(snapAfter),
      progress: progressed && ok,
      progressReason,
      progressSource,
      source: plan.source || "step-classifier",
      learnings: stepLearnings,
      existingAccount: Boolean(stepLearnings?.existingAccount),
      preferencesSignup: executed.preferencesSignupClicked || false,
      decisionPath: decision?.path,
    });

    if (stepLearnings && agentContext.targetHost) {
      try {
        const patch = {};
        if (stepLearnings.authSelectors) patch.authSelectors = stepLearnings.authSelectors;
        if (stepLearnings.modalSelector) patch.modalSelectors = [stepLearnings.modalSelector];
        if (stepLearnings.controlSkills) patch.controlSkills = stepLearnings.controlSkills;
        if (stepLearnings.affordanceSkills && progressed && ok) {
          patch.affordanceSkills = stepLearnings.affordanceSkills;
        }
        if (Object.keys(patch).length) {
          recordSiteLearning(agentContext.targetHost, patch);
        }
      } catch {
        /* ignore */
      }
    }

    if (ok && progressed && agentContext.targetHost) {
      try {
        recordCachedPlan(agentContext.targetHost, snap, plan, {
          ok,
          progressed,
          afterSnap: nextSnap || snap,
          entryKey: entryKeyForHistory || plan.entryKey || "",
          entryCandidate: executed.entryCandidate || plan.targetCandidate || null,
        });
        // Harvest Stagehand / indexed act successes into affordance skills.
        if (plan.type === "act" || plan.type === "stagehand_act") {
          const skill =
            plan.type === "act"
              ? affordanceSkillFromAct(plan, snap, { stage: classification.step, classification })
              : {
                  stage: classification.step || "any",
                  action: "click",
                  signature: `stagehand:${String(plan.instruction || "").slice(0, 80)}`,
                  intent: "entry_apply",
                  successCount: 1,
                  stagehandAction: plan.stagehandAction || null,
                };
          if (skill) {
            recordSiteLearning(agentContext.targetHost, { affordanceSkills: [skill] });
          }
        }
      } catch {
        /* ignore */
      }
    }

    // Snapshot fill state for ready criteria (original loop scored filledCount /
    // uploadsPending before Stagehand may append more fills).
    const fillResultForReady = fillResult;

    if (
      plan.type === "smart_fill" &&
      ok &&
      hasUnfilledApplicationControls(snapAfter) &&
      getSettings().stagehand_enabled
    ) {
      const sh = await attemptApplicationControlsStagehand(page, agentContext, {
        snap: snapAfter,
        log,
        history,
      });
      if (sh.ok) {
        snapAfter = await inspectPage(page);
        lastSnap = snapAfter;
        const custom = await fillCustomControls(page, agentContext, { snap: snapAfter, log });
        if (custom.filled?.length) {
          fillResult = {
            ...fillResult,
            filled: [...(fillResult.filled || []), ...custom.filled],
          };
          progressed = true;
          progressReason = "application controls via stagehand fallback";
        }
        history.push({
          step,
          action: "stagehand_act",
          applyStep: "form",
          ok: true,
          fingerprint: pageFingerprint(snapAfter),
          progress: (custom.filled?.length || 0) > 0,
          source: "application-controls",
        });
        await humanPause(600, 1000);
      }
    }

    // Text fields filled but file inputs untouched means the form isn't done —
    // keep going so the upload step runs before stopping for review.
    const { readyForReview } = evaluateReadyForReview({
      snapAfter,
      fillResult: fillResultForReady,
      history,
      progressed,
      ok,
    });

    if (plan.type === "smart_fill" && readyForReview) {
      if (settings.auto_submit === true && (snapAfter.submitCount || 0) > 0) {
        log.layer("agent", "objective: form filled — auto_submit enabled, clicking submit", "info");
        const submitPlan = { type: "click_submit", reason: "auto_submit after fill", source: "auto-submit" };
        const submitted = await executePlan(page, submitPlan, {
          snap: snapAfter,
          context: agentContext,
          log,
          url,
          sessionId,
          fillResult,
          history,
        });
        history.push({
          step,
          action: "click_submit",
          ok: submitted.ok,
          fingerprint: pageFingerprint(submitted.snap || snapAfter),
          progress: submitted.ok,
          source: "auto-submit",
        });
      } else {
        const reviewMode = settings.review_mode !== false;
        log.layer(
          "agent",
          reviewMode
            ? "handoff: review — form filled, awaiting human submit (review_mode)"
            : "objective: form filled — ready for human review/submit",
          "info",
        );
        history.push({
          step,
          action: "wait_user",
          applyStep: "review",
          ok: true,
          progress: true,
          handoff: "review",
          source: reviewMode ? "review-mode" : "ready-for-review",
        });
      }
      break;
    }

    if (progressed && ok) {
      consecutiveNoProgress = 0;
    } else {
      consecutiveNoProgress += 1;
    }

    if (isStuck(history, snapAfter) || consecutiveNoProgress >= maxNoProgress) {
      const stuckPlan = runStuckFillRecovery({
        snap: snapAfter,
        history,
        fillResult,
        force: true,
        requireUnfilledForSmartFill: true,
      });
      if (stuckPlan?.type === "smart_fill") {
        log.layer("agent", "stuck — upload stalled, forcing smart_fill", "warn");
        const fillExec = await executePlan(page, stuckPlan, {
          snap: snapAfter,
          context: agentContext,
          log,
          url,
          sessionId,
          fillResult,
          history,
          classification: lastClassification,
        });
        if (fillExec.fillResult) fillResult = fillExec.fillResult;
        history.push({
          step,
          action: "smart_fill",
          applyStep: "form",
          ok: fillExec.ok,
          fingerprint: pageFingerprint(fillExec.snap || snapAfter),
          progress: fillExec.ok,
          source: "stuck-recovery",
        });
        if (fillExec.ok) {
          consecutiveNoProgress = 0;
          await humanPause(900, 1600);
          continue;
        }
      } else if (stuckPlan?.type === "upload_resume" && !uploadAlreadySucceeded(history)) {
        log.layer("agent", "stuck — forcing upload recovery", "warn");
        const uploadOk = await uploadDiscoveredFile(page, log, "agent", snapAfter, sessionId);
        history.push({
          step,
          action: "upload_resume",
          applyStep: "upload",
          ok: uploadOk,
          fingerprint: pageFingerprint(await inspectPage(page)),
          progress: uploadOk,
          source: "stuck-recovery",
        });
        if (uploadOk) {
          consecutiveNoProgress = 0;
          await humanPause(900, 1600);
          continue;
        }
      }

      const finalTry = await attemptFinalRecovery(page, snapAfter, history, fillResult, agentContext, log, {
        url,
        sessionId,
      });
      if (finalTry.recovered) {
        if (finalTry.fillResult) fillResult = finalTry.fillResult;
        lastSnap = finalTry.snap || snapAfter;
        consecutiveNoProgress = 0;
        history.push({
          step,
          action: finalTry.plan?.type || "recovery",
          ok: true,
          fingerprint: pageFingerprint(lastSnap),
          progress: true,
          source: "end-state-recovery",
        });
        await humanPause(900, 1600);
        continue;
      }

      log.layer(
        "agent",
        consecutiveNoProgress >= maxNoProgress
          ? `no progress for ${consecutiveNoProgress} steps — stopping for review`
          : "stuck — no progress in last 3 steps",
        "warn",
      );
      break;
    }

    await humanPauseInterruptible(900, 1600, stopRequested);
    if (stopRequested()) {
      log.layer("agent", "stop requested — exiting agent loop", "info");
      history.push({ step, action: "stopped", ok: true, fingerprint: pageFingerprint(lastSnap || {}), progress: false });
      break;
    }
  }

  const finalSnap = lastSnap || (await inspectPage(page));
  const stepTrail = history.map((h) => h.applyStep || h.action).join(" → ");
  log.layer(
    "agent",
    `finished: steps=${history.length} filled=${fillResult.filled?.length || 0} score=${bestScore}`,
    "info",
  );
  if (stepTrail) log.layer("agent", `step trail: ${stepTrail}`, "debug");

  try {
    const host =
      agentContext.targetHost ||
      finalSnap.hostname ||
      (() => {
        try {
          return new URL(finalSnap.url || url || "").hostname;
        } catch {
          return "";
        }
      })();
    recordLearningsFromRun({
      hostname: host,
      history,
      fillResult,
      snap: finalSnap,
      bestScore,
      outcome: (fillResult.filled?.length || 0) >= 2 ? "success" : "partial",
    });
    appendRunHistory({
      jobId: sessionId,
      host,
      url: finalSnap?.url || url,
      success: (fillResult.filled?.length || 0) >= 2,
      filled: fillResult.filled?.length || 0,
      score: bestScore,
      outcome: (fillResult.filled?.length || 0) >= 2 ? "success" : boardLeaveSucceeded(history) ? "review" : "partial",
      trail: trailFingerprint(history).split("→"),
      fingerprint: pageFingerprint(finalSnap),
    });
  } catch {
    /* ignore learnings write errors */
  }

  return {
    prep: { actions: [...new Set(prepActions)] },
    fillResult,
    snap: finalSnap,
    history,
    agentSteps: history.length,
    lastClassification,
    page,
  };
}

/** @deprecated alias */
export const runApplyAgent = runAutomationAgent;
