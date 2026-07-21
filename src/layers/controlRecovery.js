/**
 * Immediate recovery when smart_fill + custom controls return filled=0.
 * Ladder: your AI planner+vision → Stagehand observe/act → fail.
 */
import { getSettings } from "../runtime.js";
import { hasEmptyRequiredControls } from "../controlState.js";
import { getPreferencesFromContext } from "../fillPreferences.js";
import { performGenericAct } from "./domActions.js";
import { attemptVisionFallback } from "./visionFallback.js";
import { attemptStagehandFill, replayStagehandSkill } from "./stagehandAdapter.js";
import { buildStagehandInstruction, attemptApplicationControlsStagehand } from "./stagehandPolicy.js";
import { fillCustomControls, clickPreferencesSignupCta, replayInteractionRecipe } from "../fillCustomControls.js";
import { inspectPage } from "./formDiscovery.js";
import { recordSiteLearning, mergeControlSkills } from "../siteLearnings.js";
import { normalizeHost } from "../host.js";
import { hasPreferencesGateFields } from "../fillPreferences.js";
import { hasUnfilledYesNoOrEEOC } from "../fillApplicationAnswers.js";
import { MIN_CONTROL_SKILL_SUCCESS } from "../primitives/controlPatterns.js";
import { verifyCommitted } from "../primitives/interactWidget.js";
import { probeCaptchaAfterAction } from "../captchaDetect.js";

function buildRecoveryInstruction(context, snap) {
  return buildStagehandInstruction(snap, { step: "form", confidence: "low" }, [], context);
}

/**
 * @param {import('playwright').Page} page
 * @param {object} snap
 * @param {object} context
 * @param {object} fillResult
 * @param {{ log?: object, sessionId?: string, history?: object[] }} opts
 */
export async function attemptImmediateControlRecovery(page, snap, context, fillResult, opts = {}) {
  const log = opts.log || null;

  if (hasPreferencesGateFields(snap)) {
    const { readLiveControlValue } = await import("../fillCustomControls.js");
    const { readSalaryFromPage } = await import("../primitives/comboboxWidget.js");
    const prefs = getPreferencesFromContext(context);
    log?.layer(
      "recovery",
      `preferences gate — salary=${prefs.salary || "?"} location=${prefs.location || "?"} title=${(prefs.desiredTitle || "?").slice(0, 40)}`,
      "info",
    );
    const salaryLive = (await readSalaryFromPage(page)) || (await readLiveControlValue(page, "salary"));
    const locationLive = await readLiveControlValue(page, "location");
    const titleLive = await readLiveControlValue(page, "desiredtitle");
    const needsLocation = (snap.fields || []).some((f) => /\blocation\b/i.test(`${f.label || ""}`));
    const needsTitle = (snap.fields || []).some((f) => /job title|desired/i.test(`${f.label || ""}`));
    if (salaryLive && (!needsLocation || locationLive) && (!needsTitle || titleLive)) {
      return {
        ok: true,
        fillResult: {
          ...fillResult,
          filled: [
            ...(fillResult?.filled || []),
            { mappedTo: "salary", type: "salary", source: "live_committed" },
          ],
          unfilled: (fillResult?.unfilled || []).filter((u) => !["salary", "location", "desiredtitle"].includes(u.mappedTo || u.type)),
        },
        source: "live_committed",
      };
    }
  }

  if (!hasEmptyRequiredControls(snap, fillResult)) {
    return { ok: false, fillResult, source: "skip" };
  }

  const host = normalizeHost(snap?.hostname || context?.targetHost || "");
  const skills = context?.siteLearnings?.controlSkills || [];

  for (const skill of skills) {
    if ((skill.successCount || 0) < MIN_CONTROL_SKILL_SUCCESS && !skill.stagehandAction) continue;
    if (Array.isArray(skill.steps) && skill.steps.length) {
      const replay = await replayInteractionRecipe(page, skill, log, snap);
      if (replay) {
        const mapped = skill.mappedTo || skill.type;
        const verified = skill.requiresConfirm
          ? await verifyCommitted(page, mapped, { selector: skill.triggerSelector, log })
          : true;
        if (!verified) continue;
        return {
          ok: true,
          fillResult: {
            ...fillResult,
            filled: [...(fillResult?.filled || []), { type: mapped, source: "recipe_cached", label: skill.label }],
          },
          source: "recipe_cached",
        };
      }
    }
    if (!skill.stagehandAction) continue;
    if ((skill.successCount || 0) < MIN_CONTROL_SKILL_SUCCESS) continue;
    const replay = await replayStagehandSkill(page, skill, log, { context });
    if (replay.ok) {
      const filled = [{ type: skill.mappedTo, source: "stagehand_cached", label: skill.label }];
      return { ok: true, fillResult: { ...fillResult, filled: [...(fillResult?.filled || []), ...filled] }, source: "stagehand_cached", action: skill.stagehandAction };
    }
  }

  log?.layer("recovery", "fillCustomControls before AI escalation", "info");
  const customFirst = await fillCustomControls(page, context, { snap, learnedSkills: skills, log });
  if (customFirst.ok) {
    return {
      ok: true,
      fillResult: {
        ...fillResult,
        filled: [...(fillResult?.filled || []), ...customFirst.filled],
        unfilled: customFirst.unfilled,
      },
      source: "custom_controls_recovery",
    };
  }

  if (hasUnfilledYesNoOrEEOC(snap) && getSettings().stagehand_enabled) {
    log?.layer("recovery", "visa/EEOC still unfilled — Stagehand fallback", "info");
    const sh = await attemptApplicationControlsStagehand(page, context, {
      snap,
      log,
      history: opts.history || [],
    });
    if (sh.ok) {
      const snapAfter = await inspectPage(page);
      const customAfter = await fillCustomControls(page, context, {
        snap: snapAfter,
        learnedSkills: skills,
        log,
      });
      if (customAfter.filled?.length) {
        return {
          ok: true,
          fillResult: {
            ...fillResult,
            filled: [...(fillResult?.filled || []), ...customAfter.filled],
            unfilled: customAfter.unfilled,
          },
          source: "application-controls-stagehand",
        };
      }
    }
  }

  let aiOk = false;
  if (getSettings().agent_ai) {
    log?.layer("recovery", "AI+vision for empty controls", "info");
    const classification = { step: "form", confidence: "low", reason: "filled=0 with empty controls" };
    const plan = await attemptVisionFallback(page, context, snap, opts.history || [], fillResult, classification, log);
    if (plan?.type === "act" && plan?.action) {
      const result = await performGenericAct(page, plan, { snap, log, sessionId: opts.sessionId, context });
      aiOk = result.ok;
      const challenge = await probeCaptchaAfterAction(page, {
        snap,
        error: result.error || result.message || null,
      }).catch(() => ({ detected: false }));
      if (challenge.detected) {
        log?.layer("recovery", `captcha after AI act — ${challenge.reason}`, "warn");
        return { ok: false, fillResult, source: "captcha_blocked", captcha: challenge };
      }
      if (aiOk) {
        log?.layer("recovery", `AI act succeeded: ${plan.action}`, "info");
        return {
          ok: true,
          fillResult: {
            ...fillResult,
            filled: [...(fillResult?.filled || []), { type: "ai_recovery", source: "ai_act", action: plan.action }],
          },
          source: "ai_act",
          plan,
        };
      }
    }
    if (plan?.type === "smart_fill" || !plan) {
      const custom = await fillCustomControls(page, context, { snap, learnedSkills: skills, log });
      if (custom.ok) {
        return {
          ok: true,
          fillResult: {
            ...fillResult,
            filled: [...(fillResult?.filled || []), ...custom.filled],
            unfilled: custom.unfilled,
          },
          source: "custom_controls_recovery",
        };
      }
    }
  }

  if (getSettings().stagehand_enabled) {
    const instruction = buildRecoveryInstruction(context, snap);
    log?.layer("recovery", `Stagehand fallback: ${instruction.slice(0, 100)}`, "info");
    const sh = await attemptStagehandFill(page, context, { instruction, log, variables: { salary: getPreferencesFromContext(context).salary } });
    if (sh.ok) {
      const mapped = sh.mappedTo || "salary";
      const verified = await verifyCommitted(page, mapped, { log });
      if (!verified) {
        log?.layer("recovery", "Stagehand act did not commit — skip recording", "warn");
        return { ok: false, fillResult, source: "stagehand_unverified" };
      }
      if (host && sh.action) {
        const patch = {
          controlSkills: mergeControlSkills([], [{
            label: sh.label || "custom",
            mappedTo: mapped,
            widgetType: "combobox",
            stagehandAction: sh.action,
            source: "stagehand",
            requiresConfirm: true,
            successCount: MIN_CONTROL_SKILL_SUCCESS,
          }]),
        };
        recordSiteLearning(host, patch);
      }
      if (hasPreferencesGateFields(snap)) {
        await clickPreferencesSignupCta(page, log, "recovery");
      }
      return {
        ok: true,
        fillResult: {
          ...fillResult,
          filled: [...(fillResult?.filled || []), { type: sh.mappedTo || "salary", source: "stagehand" }],
        },
        source: "stagehand",
        action: sh.action,
      };
    }
  }

  return { ok: aiOk, fillResult, source: aiOk ? "ai_act" : "failed" };
}
