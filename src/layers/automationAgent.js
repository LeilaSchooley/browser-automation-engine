import { getRuntime, getSettings } from "../runtime.js";
import { isCloudflarePage, waitForCloudflareClear } from "../cloudflare.js";
import { humanPause } from "../human.js";
import { runSmartFill } from "../smartFill.js";
import { runPagePrepRound } from "./pagePrep.js";
import {
  clickCandidate,
  clickDiscoveredContinue,
  clickDiscoveredEntry,
  clickDiscoveredModalStep,
  clickTargetCandidate,
  uploadDiscoveredFile,
} from "./domActions.js";
import {
  inspectPage,
  logPageSnapshot,
  looksLikeApplyForm,
  pageFingerprint,
  progressScore,
} from "./formDiscovery.js";
import { classifyApplyStep, stepToPlan } from "./applyStep.js";
import { isPageUnloaded, waitForApplySurface, waitAfterClickTransition } from "./pageReady.js";
import { isStuck, shouldPreferUpload, uploadAlreadySucceeded } from "../heuristics.js";

async function decideNextAction(snap, fillResult, history, context) {
  const classification = classifyApplyStep(snap, fillResult, history);
  let plan = stepToPlan(classification, snap, history);

  const { planNextAction } = getRuntime();
  const needsAi =
    getSettings().agent_ai &&
    planNextAction &&
    (!plan || classification.confidence === "low" || classification.step === "ambiguous");

  if (needsAi && !isPageUnloaded(snap)) {
    const aiPlan = await planNextAction(context, snap, history, fillResult, classification);
    if (aiPlan && !(aiPlan.type === "wait_user" && isPageUnloaded(snap))) {
      if (!plan || classification.step === "ambiguous" || classification.confidence === "low") {
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
export async function runAutomationAgent(page, context, log, { url, sessionId = null, shouldStop = null } = {}) {
  const maxSteps = Math.max(3, getSettings().agent_max_steps);
  const history = [];
  let fillResult = { filled: [], unfilled: [], unfilled_count: 0, ai_filled: 0 };
  let prepActions = [];
  let bestScore = 0;
  let lastSnap = null;
  let lastClassification = null;

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

    const { plan, classification } = await decideNextAction(snap, fillResult, history, context);
    lastClassification = classification;

    logPageSnapshot(log, snap, "agent", classification);

    const score = progressScore(snap, fillResult);
    if (score > bestScore) bestScore = score;

    if (!plan) {
      const stuck = isStuck(history, snap);
      log.layer(
        "agent",
        stuck ? "stuck — no valid action for current step" : "no action for current step — stopping",
        stuck ? "warn" : "debug",
      );
      if (stuck) break;
      break;
    }

    if (plan.type === "done" || plan.type === "wait_user") {
      log.layer("agent", `stop: ${plan.type} — ${plan.reason}`, "info");
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

    let ok = false;
    const fpBefore = pageFingerprint(snap);

    switch (plan.type) {
      case "wait_load": {
        snap = await waitForApplySurface(page, log, { timeoutMs: 14000 });
        lastSnap = snap;
        ok = !isPageUnloaded(snap);
        break;
      }
      case "accept_cookies": {
        const round = await runPagePrepRound(page, url, log, { mode: "cookies" });
        prepActions.push(...round.actions);
        ok = round.actions.includes("cookies");
        break;
      }
      case "click_apply": {
        ok = await clickDiscoveredEntry(page, log, "agent", snap);
        if (!ok) {
          const round = await runPagePrepRound(page, url, log, { mode: "entry" });
          prepActions.push(...round.actions);
          ok = round.actions.includes("entry");
        }
        if (ok) {
          await waitAfterClickTransition(page);
        }
        break;
      }
      case "click_modal": {
        ok = await clickDiscoveredModalStep(page, log, "agent", snap, sessionId);
        if (!ok && plan.targetCandidate) {
          ok = await clickCandidate(page, plan.targetCandidate, log, "agent", "modal-target", { inModal: true });
        }
        if (!ok && plan.target) {
          ok = await clickTargetCandidate(page, plan.target, log, "agent");
        }
        if (ok) await waitAfterClickTransition(page);
        break;
      }
      case "upload_resume":
      case "upload_file": {
        ok = await uploadDiscoveredFile(page, log, "agent", snap, sessionId);
        if (ok) await waitAfterClickTransition(page);
        break;
      }
      case "smart_fill": {
        if ((snap.fieldCount || 0) === 0) {
          log.layer("agent", "smart_fill skipped — 0 fields on page", "warn");
          ok = false;
        } else {
          fillResult = await runSmartFill(page, context, log, { sessionId });
          ok = (fillResult.filled?.length || 0) > 0 || (fillResult.unfilled?.length || 0) > 0;
        }
        break;
      }
      case "click_continue": {
        ok = await clickDiscoveredContinue(page, log, "agent", snap);
        if (!ok && plan.target) {
          ok = await clickTargetCandidate(page, plan.target, log, "agent");
        }
        if (ok) await waitAfterClickTransition(page);
        break;
      }
      case "click_submit": {
        const submit = snap.submitCandidates?.[0];
        if (submit) ok = await clickCandidate(page, submit, log, "agent", "submit");
        break;
      }
      default:
        break;
    }

    const snapAfter = await inspectPage(page);
    lastSnap = snapAfter;
    const progressed = pageFingerprint(snapAfter) !== fpBefore || progressScore(snapAfter, fillResult) > score;
    history.push({
      step,
      action: plan.type,
      applyStep: classification.step,
      ok,
      fingerprint: pageFingerprint(snapAfter),
      progress: progressed,
      source: plan.source || "step-classifier",
    });

    if (plan.type === "smart_fill" && (fillResult.filled?.length || 0) >= 2 && looksLikeApplyForm(snapAfter, 2)) {
      log.layer("agent", "goal: form filled — ready for review", "info");
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

  return {
    prep: { actions: [...new Set(prepActions)] },
    fillResult,
    snap: finalSnap,
    history,
    agentSteps: history.length,
    lastClassification,
  };
}

/** @deprecated alias */
export const runApplyAgent = runAutomationAgent;
