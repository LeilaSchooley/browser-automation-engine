/**
 * Execute a single agent plan action. Keeps automationAgent focused on the loop.
 */
import { humanPause } from "../human.js";
import { runSmartFill } from "../smartFill.js";
import { saveStorageState } from "../sessionStore.js";
import { attemptEmailVerify } from "../inboxVerify.js";
import { attemptOtpEntry } from "../inboxOtp.js";
import { runPagePrepRound } from "./pagePrep.js";
import {
  clickCandidate,
  clickDiscoveredContinue,
  clickDiscoveredModalStep,
  clickTargetCandidate,
  performGenericAct,
  uploadDiscoveredFile,
} from "./domActions.js";
import { attemptAuthLogin, clickSignInEntry, looksLikeAuthForm } from "./authActions.js";
import { attemptAuthSignup, clickSignupEntry, looksLikeSignupForm } from "./signupActions.js";
import { hasPreferencesGateFields } from "../fillPreferences.js";
import { controlCount } from "../controlState.js";
import { attemptImmediateControlRecovery } from "./controlRecovery.js";
import { clickPreferencesSignupCta, salaryCommittedOnPage } from "../fillCustomControls.js";
import { attemptObstacleRecovery } from "./obstacleActions.js";
import { dismissBlockingOverlays, dismissInterstitialDialog } from "./adDismiss.js";
import { acceptFundingChoicesConsent } from "./fundingChoices.js";
import { attemptCaptchaSolve } from "./captchaSolve.js";
import { waitForCaptchaClear } from "../captchaDetect.js";
import { recoverFromWrongNavigation, getTriedEntryKeys, clickRankedEntry } from "./navigationRecovery.js";
import { shouldBlockAdvance } from "../gateComplete.js";
import { shouldNeverDismiss } from "../workflowGates.js";
import { recentPreferencesSignup, preferencesSignupSubmitted, looksLikeJobBoardIndex, isResumeReviewUpsell, isExpertReviewGate } from "../heuristics.js";
import { looksLikePlatformOnboarding, tickOnboardingDefaults, looksLikeJobBoardWelcomeConfirm, clickWelcomeConfirm, looksLikeDidYouApplyPrompt, clickDidYouApplyDecline } from "../platformOnboarding.js";
import { isPageUnloaded, waitForApplySurface, waitAfterClickTransition } from "./pageReady.js";
import { inspectPage } from "./formDiscovery.js";
import { attemptStagehandAct, canUseStagehand } from "./stagehandAdapter.js";
import { buildStagehandInstruction } from "./stagehandPolicy.js";

function unwrapActionResult(result) {
  if (typeof result === "boolean") return { ok: result };
  return result && typeof result === "object" ? result : { ok: false };
}

function preferencesFillHasSalary(fillResult) {
  return (fillResult?.filled || []).some((f) => f.type === "salary" || f.mappedTo === "salary");
}

async function preferencesSalaryCommitted(page, _snap, fillResult) {
  if (await salaryCommittedOnPage(page, "salary")) return true;
  if (!preferencesFillHasSalary(fillResult)) return false;
  return salaryCommittedOnPage(page, "salary");
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
  classification = null,
  shouldStop = null,
} = {}) {
  let ok = false;
  let entryKey = "";
  let entryCandidate = null;
  let nextSnap = snap;
  let nextFill = fillResult;
  let learnings = undefined;
  let preferencesSignupClicked = false;
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
      if (await acceptFundingChoicesConsent(page, log, "agent")) {
        ok = true;
        break;
      }
      const round = await runPagePrepRound(page, url, log, { mode: "cookies" });
      prepActions.push(...(round.actions || []));
      ok = round.actions.includes("cookies");
      break;
    }
    case "dismiss_overlay": {
      if (preferencesSignupSubmitted(history) || recentPreferencesSignup(history)) {
        log?.layer("agent", "dismiss_overlay blocked — post-preferences signup transition", "warn");
        ok = false;
        break;
      }
      if (shouldNeverDismiss(snap)) {
        log?.layer("agent", "dismiss_overlay blocked — workflow gate modal (fill, don't close)", "warn");
        ok = false;
        break;
      }
      ok = await dismissBlockingOverlays(page, log, "agent", snap);
      if (!ok) {
        const round = await runPagePrepRound(page, url, log, { mode: "dismiss" });
        prepActions.push(...(round.actions || []));
        ok = round.actions.includes("dismiss");
      }
      if (!ok) log?.layer("agent", "dismiss_overlay: no dismiss control matched on this pass", "info");
      if (ok) await humanPause(800, 1500);
      break;
    }
    case "click_apply": {
      const tried = getTriedEntryKeys(history);
      const clickResult = await clickRankedEntry(page, snap, log, "agent", context, { skipKeys: tried });
      if (clickResult.blocked) {
        ok = false;
        log?.layer("agent", `click_apply blocked — ${clickResult.reason || "toxic apply link"}`, "warn");
        break;
      }
      ok = clickResult.ok;
      if (!ok) {
        const round = await runPagePrepRound(page, url, log, { mode: "entry" });
        prepActions.push(...(round.actions || []));
        ok = round.actions.includes("entry");
      }
      if (!ok && canUseStagehand(context).ok) {
        const instruction =
          plan.instruction ||
          buildStagehandInstruction(snap, classification || { step: "entry" }, history, context, {
            forceApply: true,
          });
        log?.layer("agent", `click_apply failed — Stagehand: ${instruction.slice(0, 90)}`, "warn");
        const sh = await attemptStagehandAct(page, context, { instruction, log });
        ok = sh.ok;
      }
      if (ok) await waitAfterClickTransition(page);
      entryKey = clickResult.entryKey || "";
      entryCandidate = clickResult.candidate || null;
      break;
    }
    case "click_modal": {
      const modalResult = await clickDiscoveredModalStep(page, log, "agent", snap, sessionId, history);
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
      if (Number.isInteger(plan.elementIndex)) {
        const item = (snap?.interactives || []).find((i) => i.index === plan.elementIndex);
        ok = await uploadDiscoveredFile(page, log, "agent", snap, sessionId, {
          preferredSelector: item?.selector || "",
          preferredTestId: item?.testId || "",
        });
      } else {
        ok = await uploadDiscoveredFile(page, log, "agent", snap, sessionId);
      }
      if (ok) await waitAfterClickTransition(page);
      break;
    }
    case "act": {
      if (preferencesSignupSubmitted(history) || recentPreferencesSignup(history)) {
        const item = Number.isInteger(plan.elementIndex)
          ? (snap?.interactives || []).find((i) => i.index === plan.elementIndex)
          : null;
        if (item?.testId === "modal-close") {
          log?.layer("agent", "act blocked — modal-close after preferences signup (use verify_email)", "warn");
          ok = false;
          break;
        }
      }
      const result = await performGenericAct(page, plan, { snap, log, sessionId, context });
      ok = result.ok;
      if (ok && (plan.action === "click" || plan.action === "goto" || plan.action === "upload")) {
        await waitAfterClickTransition(page);
      }
      if (ok && plan.action === "click" && Number.isInteger(plan.elementIndex)) {
        const { affordanceSkillFromAct } = await import("../siteLearnings.js");
        const skill = affordanceSkillFromAct(plan, snap, {
          stage: plan.step || classification?.step || "any",
          classification,
        });
        if (skill) learnings = { ...(learnings || {}), affordanceSkills: [skill] };
      }
      break;
    }
    case "smart_fill": {
      const controls = controlCount(snap);
      if (controls === 0 && (snap.customControlCount || 0) === 0) {
        log?.layer("agent", "smart_fill skipped — 0 fields on page", "warn");
        ok = false;
      } else if (looksLikeJobBoardIndex(snap)) {
        log?.layer("agent", "smart_fill skipped — job board index (navigation required)", "warn");
        ok = false;
      } else if (looksLikeAuthForm(snap) || looksLikeSignupForm(snap)) {
        log?.layer("agent", "smart_fill redirected — auth/signup gate", "warn");
        const authResult = unwrapActionResult(await attemptAuthSignup(page, snap, context, log));
        ok = authResult.ok || authResult.filled === true;
        learnings = authResult.learnings;
        if (ok) await waitAfterClickTransition(page);
      } else if (isResumeReviewUpsell(snap) || isExpertReviewGate(snap)) {
        log?.layer("agent", "smart_fill skipped — resume boost/upsell (dismiss instead)", "warn");
        ok = await dismissBlockingOverlays(page, log, "agent", snap);
      } else {
        nextFill = await runSmartFill(page, context, log, { sessionId, snap });
        ok = (nextFill.filled?.length || 0) > 0 || (nextFill.unfilled?.length || 0) > 0;

        const salaryAlreadyLive =
          hasPreferencesGateFields(snap) && (await preferencesSalaryCommitted(page, snap, nextFill));

        const salaryNeedsRecovery =
          !salaryAlreadyLive &&
          ((nextFill.filled?.length || 0) === 0 ||
            (hasPreferencesGateFields(snap) &&
              (!preferencesFillHasSalary(nextFill) ||
                !(await preferencesSalaryCommitted(page, snap, nextFill)))));

        if (salaryNeedsRecovery) {
          const recovery = await attemptImmediateControlRecovery(page, snap, context, nextFill, {
            log,
            sessionId,
            history,
          });
          if (recovery.ok) {
            ok = true;
            nextFill = recovery.fillResult || nextFill;
            if (recovery.action) {
              learnings = { controlSkills: [{ stagehandAction: recovery.action, source: "stagehand", mappedTo: "salary", label: "salary expectations", successCount: 2, requiresConfirm: true, confirmPattern: "Save" }] };
            }
          }
        }

        if (hasPreferencesGateFields(snap)) {
          const freshSnap = await inspectPage(page);
          nextSnap = freshSnap;
          const salaryOk = salaryAlreadyLive || (await preferencesSalaryCommitted(page, freshSnap, nextFill));
          if (salaryOk && (await clickPreferencesSignupCta(page, log, "agent"))) {
            await waitAfterClickTransition(page);
            preferencesSignupClicked = true;
            ok = true;
          } else if (preferencesFillHasSalary(nextFill) && !salaryOk) {
            log?.layer("agent", "signup CTA deferred — salary not committed on page", "warn");
          }
        }

        if (!ok || (nextFill.filled?.length || 0) === 0) {
          const salaryBlocked =
            hasPreferencesGateFields(snap) &&
            !(await preferencesSalaryCommitted(page, nextSnap || snap, nextFill));
          if (!salaryBlocked) {
            const obstacle = await attemptObstacleRecovery(page, snap, log);
            if (obstacle.ok && (nextFill.filled?.length || 0) > 0) ok = true;
          } else {
            log?.layer("agent", "obstacle recovery skipped — salary not committed", "warn");
          }
        }
      }
      break;
    }
    case "click_continue": {
      const skipGate = looksLikeDidYouApplyPrompt(snap) || looksLikeJobBoardWelcomeConfirm(snap);
      const block = skipGate ? { block: false } : await shouldBlockAdvance(snap, fillResult, page);
      if (block.block) {
        log?.layer("agent", `click_continue blocked — ${block.reason}`, "warn");
        ok = false;
        break;
      }
      if (looksLikeJobBoardWelcomeConfirm(snap)) {
        ok = await clickWelcomeConfirm(page, snap, log);
        if (ok) {
          await waitAfterClickTransition(page);
          break;
        }
      }
      {
        const liveDidYouApply = await page
          .getByText(/did you apply\??/i)
          .first()
          .isVisible({ timeout: 500 })
          .catch(() => false);
        if (liveDidYouApply || looksLikeDidYouApplyPrompt(snap) || /did-you-apply/i.test(plan?.reason || "")) {
          ok = await clickDidYouApplyDecline(page, snap, log);
          if (ok) {
            await waitAfterClickTransition(page);
            break;
          }
        }
      }
      if (looksLikePlatformOnboarding(snap)) {
        await tickOnboardingDefaults(page, log);
      }
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
      if (!ok && authResult.existingAccount) {
        log?.layer("agent", "site says account already exists — switching to sign in", "warn");
        const afterSignup = await inspectPage(page).catch(() => snap);
        const switched = await clickSignInEntry(page, afterSignup, log);
        if (switched) await waitAfterClickTransition(page);
        nextSnap = await inspectPage(page).catch(() => afterSignup);
        if (looksLikeAuthForm(nextSnap) || looksLikeSignupForm(nextSnap) === false) {
          const login = unwrapActionResult(await attemptAuthLogin(page, nextSnap, context, log));
          ok = login.ok;
          learnings = login.learnings || learnings;
          if (ok) {
            await waitAfterClickTransition(page);
            try {
              await saveStorageState(page.context(), snap.hostname || context?.targetHost);
            } catch {
              /* ignore */
            }
          }
        }
        // Preserve signal for classifier / history even if login still needs another step.
        learnings = { ...(learnings || {}), existingAccount: true };
      } else if (ok) {
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
      if (obstacle.hardStop && /captcha|human verification/i.test(obstacle.reason || "")) {
        const solved = await attemptCaptchaSolve(page, snap, log);
        if (solved.ok) {
          ok = true;
          break;
        }
        ok = await waitForCaptchaClear(page, sessionId, {
          initial: { reason: obstacle.reason, source: "clear_obstacle" },
        });
      }
      break;
    }
    case "verify_email": {
      ok = await attemptEmailVerify(page, snap, log, { sessionId });
      if (ok) await waitAfterClickTransition(page);
      break;
    }
    case "enter_otp":
    case "wait_otp": {
      ok = await attemptOtpEntry(page, snap, log, { sessionId, context });
      if (ok) await waitAfterClickTransition(page);
      break;
    }
    case "nav_recovery": {
      const recovery = await recoverFromWrongNavigation(page, snap, context, history, log, { sessionId });
      ok = recovery.recovered;
      if (recovery.recovered) nextSnap = recovery.snap || snap;
      break;
    }
    case "stagehand_act": {
      const instruction = plan.instruction || plan.target || "";
      const urlBefore = String(snap?.url || "");
      const boardBefore = looksLikeJobBoardIndex(snap);
      const sh = await attemptStagehandAct(page, context, {
        instruction,
        log,
        variables: plan.variables,
        shouldStop,
      });
      ok = sh.ok;
      if (ok) await waitAfterClickTransition(page);
      nextSnap = await inspectPage(page).catch(() => snap);
      const urlAfter = String(nextSnap?.url || "");
      const leftBoard = boardBefore && !looksLikeJobBoardIndex(nextSnap);
      const urlChanged = urlAfter && urlAfter !== urlBefore;
      if (ok && boardBefore && !leftBoard && !urlChanged) {
        log?.layer("stagehand", "board act made no navigation progress", "warn");
        ok = false;
      }
      if (ok && sh.action) {
        learnings = {
          controlSkills: [
            {
              stagehandAction: sh.action,
              source: "stagehand",
              label: plan.reason || "navigate",
              mappedTo: plan.mappedTo || (boardBefore ? "board_nav" : "navigate"),
              intent: boardBefore || plan.mappedTo === "board_nav" ? "board_nav" : undefined,
              successCount: 2,
            },
          ],
        };
        if (boardBefore || plan.mappedTo === "board_nav") {
          learnings.affordanceSkills = [
            {
              stage: "entry",
              action: "click",
              intent: "board_nav",
              signature: {
                role: "link",
                textNorm: String(context?.job?.title || plan.reason || "job listing")
                  .toLowerCase()
                  .slice(0, 80),
                inModal: false,
                testId: "",
                kind: "board_nav",
              },
              successCount: 1,
            },
          ];
        }
      }
      break;
    }
    case "click_signup": {
      const block = await shouldBlockAdvance(snap, fillResult, page);
      if (block.block) {
        log?.layer("agent", `click_signup blocked — ${block.reason}`, "warn");
        ok = false;
        break;
      }
      ok = await clickSignupEntry(page, snap, log);
      if (ok) {
        await waitAfterClickTransition(page);
        await humanPause(1000, 1800);
      }
      break;
    }
    case "click_signin": {
      ok = await clickSignInEntry(page, snap, log);
      if (ok) {
        await waitAfterClickTransition(page);
        await humanPause(800, 1400);
      }
      break;
    }
    default:
      break;
  }

  return {
    ok,
    snap: nextSnap,
    entryKey,
    entryCandidate,
    fillResult: nextFill,
    prepActions,
    learnings,
    preferencesSignupClicked,
  };
}
