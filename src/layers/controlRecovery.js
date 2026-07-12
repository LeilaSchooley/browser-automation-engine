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
import { fillCustomControls, clickPreferencesSignupCta } from "../fillCustomControls.js";
import { recordSiteLearning, mergeControlSkills } from "../siteLearnings.js";
import { normalizeHost } from "../host.js";
import { hasPreferencesGateFields } from "../fillPreferences.js";

function buildRecoveryInstruction(context, snap) {
  const prefs = getPreferencesFromContext(context);
  if (hasPreferencesGateFields(snap)) {
    const parts = [];
    if (prefs.salary) parts.push(`select Salary expectations closest to ${prefs.salary}`);
    if (prefs.location) parts.push(`ensure Location is ${prefs.location}`);
    if (prefs.desiredTitle) parts.push(`ensure Desired job title is set`);
    return `In the preferences modal: ${parts.join("; ")}`;
  }
  return "Fill any empty required form fields using the applicant profile and job context";
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
  if (!hasEmptyRequiredControls(snap, fillResult)) {
    return { ok: false, fillResult, source: "skip" };
  }

  const host = normalizeHost(snap?.hostname || context?.targetHost || "");
  const skills = context?.siteLearnings?.controlSkills || [];

  for (const skill of skills) {
    if (!skill.stagehandAction) continue;
    const replay = await replayStagehandSkill(page, skill, log);
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

  let aiOk = false;
  if (getSettings().agent_ai) {
    log?.layer("recovery", "AI+vision for empty controls", "info");
    const classification = { step: "form", confidence: "low", reason: "filled=0 with empty controls" };
    const plan = await attemptVisionFallback(page, context, snap, opts.history || [], fillResult, classification, log);
    if (plan?.type === "act" && plan?.action) {
      const result = await performGenericAct(page, plan, { snap, log, sessionId: opts.sessionId, context });
      aiOk = result.ok;
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
      if (host && sh.action) {
        const patch = {
          controlSkills: mergeControlSkills([], [{
            label: sh.label || "custom",
            mappedTo: sh.mappedTo || "salary",
            widgetType: "combobox",
            stagehandAction: sh.action,
            source: "stagehand",
            successCount: 1,
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
