import { getRuntime, getSettings } from "../runtime.js";
import { applyAffordances } from "./formDiscovery.js";
import { applicantPromptBlock, hasIdentityRegistrationFields, resolveIdentityFillValue } from "../fillProfile.js";
import {
  hasPreferencesGateFields,
  preferencesGateIncomplete,
  preferencesPromptBlock,
  resolvePreferenceFillValue,
} from "../fillPreferences.js";
import { isWorkflowGateModal } from "../workflowGates.js";
import { buildAgentContext } from "./agentContext.js";
import { buildPageState } from "./pageState.js";
import { AgentPlanSchema, GENERIC_ACTIONS, HIGH_LEVEL_ACTIONS, parseJsonFromLlm } from "../ai/contracts.js";

function objectiveLabel(context) {
  const job = context?.job || {};
  const title = job.title || context?.title || context?.objective?.title || "";
  const company = job.company || context?.company || context?.objective?.company || "";
  if (title && company) return `${title} at ${company}`;
  return title || company || context?.objective || "application form";
}

/**
 * Default AI planner — high-level steps or generic primitives (click/fill/goto/…).
 * Uses runtime.callLlm when agent_ai is enabled.
 */
export async function planNextAction(context, snap, history, fillResult, classification = null, page = null) {
  const settings = getSettings();
  const { callLlm } = getRuntime();
  if (!settings.agent_ai || typeof callLlm !== "function") return null;

  const hasAffordances =
    snap.title ||
    snap.cookieBanner ||
    snap.entryCount ||
    snap.hasApplyModal ||
    (snap.interactives || []).length > 0 ||
    (snap.fieldCount || 0) > 0;
  if (!hasAffordances && snap.pageKind === "unknown") return null;

  const agentCtx = await buildAgentContext(snap, fillResult, page);
  const pageState = agentCtx.pageState;

  if (pageState.uiPhase === "option_selected_uncommitted") {
    const confirm = pageState.confirmAffordances?.[0];
    if (confirm?.text) {
      return {
        type: "act",
        action: "click",
        target: confirm.text,
        reason: `commit pending selection — click ${confirm.text}`,
        source: "ai-layout-commit",
      };
    }
    return {
      type: "act",
      action: "click",
      target: "Save",
      reason: "selection made but not committed — click Save or confirm",
      source: "ai-layout-commit",
    };
  }

  if (
    hasPreferencesGateFields(snap) &&
    preferencesGateIncomplete(snap, fillResult) &&
    pageState.uiPhase !== "picker_open"
  ) {
    return {
      type: "smart_fill",
      target: "",
      reason: "preferences gate — fill location, title, and salary",
      source: "ai-preferences",
    };
  }

  if (hasIdentityRegistrationFields(snap) || ((snap.fieldCount || 0) >= 2 && snap.pageKind === "auth")) {
    return {
      type: "smart_fill",
      target: "",
      reason: "identity/auth fields visible — fill from applicant profile",
      source: "ai-profile",
    };
  }

  const recent = (history || [])
    .slice(-8)
    .map((h) => `${h.applyStep || h.action}${h.ok ? "" : " FAILED"}${h.progress ? "" : " (no progress)"}`)
    .join(" → ");
  const afford = applyAffordances(snap, pageState);
  const classInfo = classification
    ? `Classifier soft prior: ${classification.step} (confidence=${classification.confidence}) — ${classification.reason}`
    : "No classification available";
  const autoSubmit = settings.auto_submit === true;

  const prompt = `You are a browser action brain. Goal: reach and fill the real application form. Skip upsells, paywalls, resume-score teases, and newsletter gates. Never invent credentials.

Target: ${objectiveLabel(context)}
URL: ${snap.url}
Title: ${snap.title || "?"} | pageKind=${snap.pageKind}
${classInfo}
Affordances: ${JSON.stringify(afford)}
${agentCtx.layoutBlock}
${agentCtx.fieldsBlock}
Filled so far: ${fillResult?.filled?.length || 0}
Recent actions: ${recent || "none"}

ELEMENTS (numbered — prefer these by elementIndex; do NOT require CTA text to match a known list):
${agentCtx.interactivesBlock}
${agentCtx.softHintsBlock || ""}
${applicantPromptBlock(context)}
${preferencesPromptBlock(context)}
${context?.ariaSnapshot || ""}

Pick ONE next action. Return ONLY JSON (no markdown):
{
  "action": "click" | "fill" | "upload" | "select" | "check" | "uncheck" | "press" | "scroll" | "goto" | "smart_fill" | "upload_resume" | "accept_cookies" | "wait" | "done" | "wait_user" | "click_continue" | "click_submit" | "click_apply" | "click_modal" | "dismiss_overlay",
  "elementIndex": 3,
  "target": "optional fallback text/CSS when no elementIndex",
  "value": "text to type (fill/select) or key name (press)",
  "url": "absolute URL (goto only)",
  "reason": "one short sentence"
}

How to choose:
- Prefer generic primitives with elementIndex from ELEMENTS over high-level dismiss_overlay / click_apply whenever a matching control is visible.
- Upsell/paywall/resume-score modals: click the secondary/least-prominent control that declines (Skip / No thanks / Continue with basic / similar) by elementIndex — even if the label is novel.
- Do not require CTA wording to match a known phrase list; use modal body + visual role.
- If LAYOUT shows pendingCommits, resolve those before Continue or Sign up.
- Combobox showing ? means unfilled even if an option was highlighted in a picker.
- Stacked dialogs: act on the topmost dialog per LAYOUT active dialog.
- After upload_resume succeeded, if a polish/upsell modal appears, dismiss it via click+elementIndex — do not re-upload or restart Apply.
- Use smart_fill when multiple form fields are empty and ready.
- Use upload / upload_resume when a file input is the next required step.
- Cross-domain apply links are normal — follow them.
- wait if the page is still loading; wait_user only for CAPTCHA, payment, or login you cannot pass.
- done ONLY when application fields are filled and a human should review${autoSubmit ? "" : "/submit"}. Never done on an untouched listing page.
${!autoSubmit ? "- Do NOT click_submit — stop with done when the form is filled so a human can submit.\n" : "- click_submit only when required fields look filled.\n"}- Never fill site-search boxes or click ads/share/cookie-settings unless required.
- If the last action FAILED, pick a different strategy.`;

  const imageBase64 = context?.vision?.screenshotBase64 || "";
  let text = await callLlm(
    imageBase64
      ? `${prompt}\n\nA screenshot of the current page is attached — use it with ELEMENTS to pick elementIndex. Novel CTA labels are fine.`
      : prompt,
    { imageBase64 },
  );
  if (!text) return null;

  const data = parseJsonFromLlm(text, AgentPlanSchema);
  if (!data) return null;

  try {
    const action = String(data.action || "").toLowerCase();
    const highLevel = new Set(HIGH_LEVEL_ACTIONS);
    const generic = new Set(GENERIC_ACTIONS);

    if (generic.has(action)) {
      const elementIndex = Number.isInteger(data.elementIndex) ? data.elementIndex : null;
      if (action === "click" && elementIndex === null && !data.target) return null;
      if (action === "fill" && !String(data.value ?? "").trim()) return null;
      if (action === "select" && !String(data.value ?? "").trim() && elementIndex === null && !data.target) return null;
      if (action === "goto" && !/^https?:/i.test(data.url || data.target || "")) return null;
      let value = data.value || "";
      if (action === "fill") {
        const item = (snap.interactives || []).find((i) => i.index === elementIndex);
        const hint = [data.target, item?.text, item?.aria, item?.kind].filter(Boolean).join(" ");
        value = resolveIdentityFillValue(hint, value, context);
        value = resolvePreferenceFillValue(hint, value, context);
      }
      return {
        type: "act",
        action,
        elementIndex,
        target: data.target || "",
        value,
        url: data.url || "",
        reason: data.reason || `AI ${action}`,
        source: "ai",
      };
    }

    if (!highLevel.has(action)) return null;

    if (
      (action === "dismiss_overlay" || action === "click_continue") &&
      (isWorkflowGateModal(snap) || hasPreferencesGateFields(snap)) &&
      preferencesGateIncomplete(snap, fillResult)
    ) {
      return {
        type: "smart_fill",
        target: "",
        reason: "workflow gate open — fill fields instead of advancing or closing",
        source: "ai-corrected",
      };
    }

    if (action === "dismiss_overlay" && isWorkflowGateModal(snap)) {
      return {
        type: hasPreferencesGateFields(snap) ? "smart_fill" : "auth_signup",
        target: "",
        reason: "workflow gate — never dismiss registration/preferences modal",
        source: "ai-corrected",
      };
    }

    if (action === "dismiss_overlay" && hasIdentityRegistrationFields(snap)) {
      return {
        type: "smart_fill",
        target: "",
        reason: "registration form open — fill profile instead of dismissing",
        source: "ai-corrected",
      };
    }

    if (action === "click_submit" && !autoSubmit) {
      return {
        type: "done",
        target: "",
        reason: data.reason || "form ready — human should submit",
        source: "ai-corrected",
      };
    }

    if (action === "smart_fill" && (snap.fieldCount || 0) === 0) {
      if ((snap.modalStepCount || 0) > 0) {
        return {
          type: "click_modal",
          target: snap.modalCandidates?.[0]?.testId || data.target || "",
          reason: "AI wanted smart_fill but no fields — clicking modal step instead",
          source: "ai-corrected",
        };
      }
      return {
        type: "wait",
        target: "",
        reason: "AI wanted smart_fill but no fields visible yet",
        source: "ai-corrected",
      };
    }

    return {
      type: action,
      target: data.target || "",
      targetCandidate: null,
      reason: data.reason || "AI plan",
      source: "ai",
    };
  } catch {
    return null;
  }
}

export { buildPageState };
