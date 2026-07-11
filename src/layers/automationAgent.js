import { getRuntime, getSettings } from "../runtime.js";
import { isCloudflarePage, waitForCloudflareClear } from "../cloudflare.js";
import { humanPause } from "../human.js";
import { uploadDiscoveredFile } from "./domActions.js";
import {
  inspectPage,
  logPageSnapshot,
  looksLikeApplyForm,
  pageFingerprint,
  progressScore,
} from "./formDiscovery.js";
import { classifyApplyStep, stepToPlan } from "./applyStep.js";
import { adoptOpenedPage, isPageUnloaded, waitForApplySurface } from "./pageReady.js";
import { allowsHostHop, normalizeHost } from "../host.js";
import { gotoWithCloudflareRetry } from "../cloudflare.js";
import { isStuck, shouldPreferUpload, uploadAlreadySucceeded, isBlockingInterstitial } from "../heuristics.js";
import { looksLikeHardGate, looksLikeAuthForm } from "./authActions.js";
import { looksLikeSignupForm } from "./signupActions.js";
import { recordSiteLearning, loadSiteLearnings } from "../siteLearnings.js";
import { recordLearningsFromRun } from "../learningRecorder.js";
import {
  enrichContextWithLearnings,
  recoverFromWrongNavigation,
  shouldAttemptNavRecovery,
} from "./navigationRecovery.js";
import { attemptObstacleRecovery } from "./obstacleActions.js";
import { attemptVisionFallback } from "./visionFallback.js";
import { attemptCaptchaSolve } from "./captchaSolve.js";
import { executePlan } from "./executePlan.js";

export async function decideNextAction(snap, fillResult, history, context) {
  const classification = classifyApplyStep(snap, fillResult, history, context);
  let plan = stepToPlan(classification, snap, history);

  const { planNextAction } = getRuntime();
  // Heuristics are the fast path; the AI takes over not just on ambiguity but
  // whenever the last steps made no progress — the classifier is out of moves.
  // Also escalate when a non-apply dialog is likely blocking (upsell / interstitial)
  // even if the classifier confidently picked cookies or listing.
  const stalled = history.length >= 2 && history.slice(-2).every((h) => !h.progress);
  const interstitialLikely =
    isBlockingInterstitial(snap) ||
    ((snap.modalCount || 0) > 0 &&
      (snap.interactives || []).some(
        (i) => i.inModal && /^(skip|no[, ]?thanks|not now|maybe later|dismiss)$/i.test(String(i.text || "").trim()),
      ));
  const needsAi =
    getSettings().agent_ai &&
    planNextAction &&
    (!plan ||
      classification.confidence === "low" ||
      classification.step === "ambiguous" ||
      stalled ||
      (interstitialLikely && ["consent", "listing", "ambiguous"].includes(classification.step)));

  if (needsAi && !isPageUnloaded(snap)) {
    const aiPlan = await planNextAction(context, snap, history, fillResult, classification);
    if (aiPlan && !(aiPlan.type === "wait_user" && isPageUnloaded(snap))) {
      if (
        !plan ||
        classification.step === "ambiguous" ||
        classification.confidence === "low" ||
        stalled ||
        (interstitialLikely && ["consent", "listing"].includes(classification.step))
      ) {
        plan = aiPlan;
      }
    }
  }

  if (!plan && isStuck(history, snap) && shouldPreferUpload(snap, history)) {
    plan = {
      type: "upload_resume",
      reason: "stuck — force file upload attempt",
      source: "stuck-recovery",
      step: "upload",
    };
  }

  return { plan, classification };
}

/**
 * Dynamic automation agent — observe → classify step → decide → act loop.
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
  let fillResult = { filled: [], unfilled: [], unfilled_count: 0, ai_filled: 0 };
  let prepActions = [];
  let bestScore = 0;
  let lastSnap = null;
  let lastClassification = null;

  let recoveryRounds = 0;
  const maxRecoveryRounds = 3;

  const hopAllowed = allowsHostHop(agentContext);
  const maxHostHops = 6;
  let hostHops = 0;
  let knownPages = new Set();
  try {
    knownPages = new Set(page.context().pages());
  } catch {
    /* non-Playwright page in tests */
  }

  log.step("agent", `Dynamic agent (max ${maxSteps} steps, affordance-driven)…`);

  for (let step = 1; step <= maxSteps; step++) {
    if (shouldStop?.()) {
      log.layer("agent", "stop requested — exiting agent loop", "info");
      history.push({ step, action: "stopped", ok: true, fingerprint: pageFingerprint(lastSnap || {}), progress: false });
      break;
    }

    if (await isCloudflarePage(page)) {
      log.layer("agent", "cloudflare — waiting", "warn");
      await waitForCloudflareClear(page, sessionId);
    }

    let snap = await inspectPage(page);
    lastSnap = snap;

    let { plan, classification } = await decideNextAction(snap, fillResult, history, agentContext);
    lastClassification = classification;

    logPageSnapshot(log, snap, "agent", classification);

    const score = progressScore(snap, fillResult);
    if (score > bestScore) bestScore = score;

    // "done" must be earned: either the classifier reached review, or we actually
    // filled fields on something that looks like an apply form. An AI plan saying
    // "done" on an untouched listing page is a hallucination — keep working.
    if (plan?.type === "done") {
      const filledCount = fillResult.filled?.length || 0;
      const earned =
        classification.step === "review" || (filledCount >= 1 && looksLikeApplyForm(snap, 1));
      if (!earned) {
        log.layer("agent", `ignoring done (${plan.reason}) — no filled apply form yet, continuing`, "warn");
        plan = null;
      }
    }

    if (!plan && objectiveMode && recoveryRounds < maxRecoveryRounds) {
      recoveryRounds += 1;
      const obstacle = await attemptObstacleRecovery(page, snap, log);
      if (obstacle.hardStop) {
        if (obstacle.reason?.includes("CAPTCHA")) {
          const solved = await attemptCaptchaSolve(page, snap, log);
          if (solved.ok) {
            history.push({ step, action: "captcha_solve", ok: true, progress: true });
            continue;
          }
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
        plan = {
          type: looksLikeSignupForm(snap) ? "auth_signup" : "auth_login",
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
          plan = {
            type: looksLikeSignupForm(snap) ? "auth_signup" : "auth_login",
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
      `step ${step}/${maxSteps}: ${plan.type} (classified=${classification.step}, conf=${classification.confidence}) — ${plan.reason}`,
      "info",
    );

    const fpBefore = pageFingerprint(snap);
    const filledBefore = fillResult.filled?.length || 0;
    const executed = await executePlan(page, plan, {
      snap,
      context: agentContext,
      log,
      url,
      sessionId,
      fillResult,
      history,
    });

    let ok = executed.ok;
    const entryKeyForHistory = executed.entryKey || "";
    if (executed.fillResult) fillResult = executed.fillResult;
    if (executed.snap) lastSnap = executed.snap;
    if (executed.prepActions?.length) prepActions.push(...executed.prepActions);
    const stepLearnings = executed.learnings;

    // Apply links with target=_blank open the next hop in a new tab — follow it.
    // Only adopt when the current page stayed put; if it navigated, the flow
    // continued here and any stray popup is likely an ad.
    if (["click_apply", "click_modal", "click_continue", "click_signup", "act"].includes(plan.type)) {
      let stayedPut = true;
      try {
        stayedPut = page.url() === (snap.url || page.url());
      } catch {
        /* ignore */
      }
      if (stayedPut) {
        const adopted = await adoptOpenedPage(page, knownPages, log);
        if (adopted) {
          page = adopted;
          ok = true;
          await waitForApplySurface(page, log, { timeoutMs: 15000 });
        }
      }
      try {
        knownPages = new Set(page.context().pages());
      } catch {
        /* ignore */
      }
    }

    let snapAfter = await inspectPage(page);
    lastSnap = snapAfter;
    let progressed = pageFingerprint(snapAfter) !== fpBefore || progressScore(snapAfter, fillResult) > score;

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

    // Redirect chains legitimately change hosts; retarget so entry ranking and
    // learnings follow the chain instead of fighting it.
    if (hopAllowed && !isPageUnloaded(snapAfter)) {
      const newHost = normalizeHost(snapAfter.hostname || snapAfter.url);
      if (newHost && agentContext.targetHost && newHost !== agentContext.targetHost) {
        hostHops += 1;
        if (hostHops > maxHostHops) {
          log.layer("agent", `too many host hops (${hostHops}) — stopping chain`, "warn");
          break;
        }
        log.layer("agent", `hop ${hostHops}: redirect chain → ${newHost}`, "info");
        const rehydrated = enrichContextWithLearnings(
          { ...agentContext, targetHost: newHost, siteLearnings: undefined, avoidEntryKeys: [] },
          newHost,
        );
        agentContext.targetHost = rehydrated.targetHost;
        agentContext.siteLearnings = rehydrated.siteLearnings;
        agentContext.avoidEntryKeys = rehydrated.avoidEntryKeys;
      }
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
    const { validateAction } = getRuntime();
    if (typeof validateAction === "function") {
      try {
        const verdict = await validateAction({
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

    history.push({
      step,
      action: plan.type,
      applyStep: classification.step,
      ok,
      entryKey: entryKeyForHistory || undefined,
      fromFingerprint: fpBefore,
      fingerprint: pageFingerprint(snapAfter),
      progress: progressed && ok,
      progressReason,
      progressSource,
      source: plan.source || "step-classifier",
      learnings: stepLearnings,
    });

    if (stepLearnings && agentContext.targetHost) {
      try {
        const patch = {};
        if (stepLearnings.authSelectors) patch.authSelectors = stepLearnings.authSelectors;
        if (stepLearnings.modalSelector) patch.modalSelectors = [stepLearnings.modalSelector];
        if (Object.keys(patch).length) {
          recordSiteLearning(agentContext.targetHost, patch);
        }
      } catch {
        /* ignore */
      }
    }

    const filledCount = fillResult.filled?.length || 0;
    const authSucceeded = history.some(
      (h) => (h.action === "auth_login" || h.action === "auth_signup") && h.ok,
    );
    // Text fields filled but file inputs untouched means the form isn't done —
    // keep going so the upload step runs before stopping for review.
    const uploadsPending =
      (snapAfter.fileInputCount || 0) > 0 &&
      !uploadAlreadySucceeded(history) &&
      !(fillResult.filled || []).some((f) => f.uploaded || f.file);
    const readyForReview =
      !uploadsPending &&
      ((filledCount >= 2 && looksLikeApplyForm(snapAfter, 2)) ||
        (filledCount >= 1 && authSucceeded && looksLikeApplyForm(snapAfter, 1)) ||
        (filledCount >= 2 && progressed && ok));

    if (plan.type === "smart_fill" && readyForReview) {
      log.layer("agent", "objective: form filled — ready for review", "info");
      break;
    }

    if (isStuck(history, snapAfter)) {
      if (!uploadAlreadySucceeded(history) && shouldPreferUpload(snapAfter, history)) {
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
          await humanPause(900, 1600);
          continue;
        }
      }
      log.layer("agent", "stuck — no progress in last 3 steps", "warn");
      break;
    }

    await humanPause(900, 1600);
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
