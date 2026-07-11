/**
 * Execute a single agent plan action. Keeps automationAgent focused on the loop.
 */
import { humanPause } from "../human.js";
import { runSmartFill } from "../smartFill.js";
import { saveStorageState } from "../sessionStore.js";
import { attemptEmailVerify } from "../inboxVerify.js";
import { runPagePrepRound } from "./pagePrep.js";
import {
  clickCandidate,
  clickDiscoveredContinue,
  clickDiscoveredModalStep,
  clickTargetCandidate,
  performGenericAct,
  uploadDiscoveredFile,
} from "./domActions.js";
import { attemptAuthLogin, looksLikeAuthForm } from "./authActions.js";
import { attemptAuthSignup, clickSignupEntry, looksLikeSignupForm } from "./signupActions.js";
import { attemptObstacleRecovery } from "./obstacleActions.js";
import { dismissBlockingOverlays, dismissInterstitialDialog } from "./adDismiss.js";
import { attemptCaptchaSolve } from "./captchaSolve.js";
import { recoverFromWrongNavigation, getTriedEntryKeys, clickRankedEntry } from "./navigationRecovery.js";
import { isPageUnloaded, waitForApplySurface, waitAfterClickTransition } from "./pageReady.js";

function unwrapActionResult(result) {
  if (typeof result === "boolean") return { ok: result };
  return result && typeof result === "object" ? result : { ok: false };
}

/**
 * @returns {Promise<{ ok: boolean, snap?: object, entryKey?: string, fillResult?: object, learnings?: object }>}
 */
export async function executePlan(page, plan, {
  snap,
  context,
  log,
  url,
  sessionId = null,
  fillResult = null,
  history = [],
} = {}) {
  let ok = false;
  let entryKey = "";
  let entryCandidate = null;
  let nextSnap = snap;
  let nextFill = fillResult;
  let learnings = undefined;
  const prepActions = [];

  switch (plan.type) {
    case "wait_load": {
      nextSnap = await waitForApplySurface(page, log, { timeoutMs: 14000 });
      ok = !isPageUnloaded(nextSnap);
      break;
    }
    case "accept_cookies": {
      // Interstitial dialogs often sit above cookie chrome — dismiss those first.
      if (await dismissInterstitialDialog(page, log, "agent")) {
        ok = true;
        break;
      }
      const round = await runPagePrepRound(page, url, log, { mode: "cookies" });
      prepActions.push(...(round.actions || []));
      ok = round.actions.includes("cookies");
      break;
    }
    case "dismiss_overlay": {
      ok = await dismissBlockingOverlays(page, log, "agent", snap);
      if (!ok) {
        const round = await runPagePrepRound(page, url, log, { mode: "dismiss" });
        prepActions.push(...(round.actions || []));
        ok = round.actions.includes("dismiss");
      }
      if (ok) await humanPause(800, 1500);
      break;
    }
    case "click_apply": {
      const tried = getTriedEntryKeys(history);
      const clickResult = await clickRankedEntry(page, snap, log, "agent", context, { skipKeys: tried });
      ok = clickResult.ok;
      if (!ok) {
        const round = await runPagePrepRound(page, url, log, { mode: "entry" });
        prepActions.push(...(round.actions || []));
        ok = round.actions.includes("entry");
      }
      if (ok) await waitAfterClickTransition(page);
      entryKey = clickResult.entryKey || "";
      entryCandidate = clickResult.candidate || null;
      break;
    }
    case "click_modal": {
      const modalResult = await clickDiscoveredModalStep(page, log, "agent", snap, sessionId);
      ok = modalResult.ok;
      if (!ok && plan.targetCandidate) {
        ok = await clickCandidate(page, plan.targetCandidate, log, "agent", "modal-target", { inModal: true });
        if (ok && plan.targetCandidate?.selector) {
          learnings = { modalSelector: plan.targetCandidate.selector };
        }
      }
      if (!ok && plan.target) {
        ok = await clickTargetCandidate(page, plan.target, log, "agent");
      }
      if (ok && modalResult.selector) {
        learnings = { modalSelector: modalResult.selector };
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
        log?.layer("agent", "smart_fill skipped — 0 fields on page", "warn");
        ok = false;
      } else if (looksLikeAuthForm(snap) || looksLikeSignupForm(snap)) {
        log?.layer("agent", "smart_fill redirected — auth wall detected", "warn");
        const authResult = unwrapActionResult(
          looksLikeSignupForm(snap)
            ? await attemptAuthSignup(page, snap, context, log)
            : await attemptAuthLogin(page, snap, context, log),
        );
        ok = authResult.ok;
        learnings = authResult.learnings;
        if (ok) await waitAfterClickTransition(page);
      } else {
        nextFill = await runSmartFill(page, context, log, { sessionId });
        ok = (nextFill.filled?.length || 0) > 0 || (nextFill.unfilled?.length || 0) > 0;
        if (!ok || (nextFill.filled?.length || 0) === 0) {
          const obstacle = await attemptObstacleRecovery(page, snap, log);
          if (obstacle.ok) ok = true;
        }
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
    case "auth_login": {
      const authResult = unwrapActionResult(await attemptAuthLogin(page, snap, context, log));
      ok = authResult.ok;
      learnings = authResult.learnings;
      if (ok) {
        await waitAfterClickTransition(page);
        await humanPause(1200, 2200);
        try {
          await saveStorageState(page.context(), snap.hostname || context?.targetHost);
        } catch {
          /* ignore */
        }
      }
      break;
    }
    case "auth_signup": {
      const authResult = unwrapActionResult(await attemptAuthSignup(page, snap, context, log));
      ok = authResult.ok;
      learnings = authResult.learnings;
      if (ok) {
        await waitAfterClickTransition(page);
        await humanPause(1500, 2600);
        try {
          await saveStorageState(page.context(), snap.hostname || context?.targetHost);
        } catch {
          /* ignore */
        }
      }
      break;
    }
    case "clear_obstacle": {
      const obstacle = await attemptObstacleRecovery(page, snap, log);
      ok = obstacle.ok;
      if (obstacle.hardStop && obstacle.reason?.includes("CAPTCHA")) {
        const solved = await attemptCaptchaSolve(page, snap, log);
        ok = solved.ok;
      }
      break;
    }
    case "verify_email": {
      ok = await attemptEmailVerify(page, snap, log);
      if (ok) await waitAfterClickTransition(page);
      break;
    }
    case "nav_recovery": {
      const recovery = await recoverFromWrongNavigation(page, snap, context, history, log, { sessionId });
      ok = recovery.recovered;
      if (recovery.recovered) nextSnap = recovery.snap || snap;
      break;
    }
    case "act": {
      const result = await performGenericAct(page, plan, { snap, log, sessionId });
      ok = result.ok;
      if (ok && (plan.action === "click" || plan.action === "goto")) {
        await waitAfterClickTransition(page);
      }
      break;
    }
    case "click_signup": {
      ok = await clickSignupEntry(page, snap, log);
      if (ok) {
        await waitAfterClickTransition(page);
        await humanPause(1000, 1800);
      }
      break;
    }
    default:
      break;
  }

  return { ok, snap: nextSnap, entryKey, entryCandidate, fillResult: nextFill, prepActions, learnings };
}
