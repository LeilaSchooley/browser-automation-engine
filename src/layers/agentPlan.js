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

const HIGH_LEVEL_ACTIONS = new Set([
  "accept_cookies",
  "dismiss_overlay",
  "click_apply",
  "click_modal",
  "upload_resume",
  "smart_fill",
  "click_continue",
  "click_submit",
  "wait",
  "done",
  "wait_user",
]);

const GENERIC_ACTIONS = new Set(["click", "fill", "goto", "press", "scroll", "select", "check", "uncheck"]);

function renderInteractives(snap) {
  const items = (snap.interactives || []).filter((i) => {
    const text = `${i.text || ""} ${i.aria || ""}`.toLowerCase();
    if (i.inModal) return true;
    if (i.kind === "combobox" || i.role === "combobox") return true;
    if (/continue|sign up|submit|next|salary|location|desired job/i.test(text)) return true;
    if (i.inApplyModal) return true;
    return false;
  });
  const limit = items.length ? Math.min(items.length, 32) : (snap.entryCount || 0) === 0 && (snap.fieldCount || 0) === 0 ? 48 : 28;
  const slice = (items.length ? items : (snap.interactives || [])).slice(0, limit);
  if (!items.length) return "(no element map — use high-level actions)";
  return slice
    .map((i) => {
      const flags = [i.inModal ? "modal" : "", i.inNav ? "nav" : "", i.inFooter ? "footer" : ""]
        .filter(Boolean)
        .join(",");
      const href = i.href ? ` href=${i.href}` : "";
      const testId = i.testId ? ` testid=${i.testId}` : "";
      return `#${i.index} [${i.kind}/${i.tag}] "${i.text || i.aria || "?"}"${href}${testId}${flags ? ` (${flags})` : ""}`;
    })
    .join("\n");
}

function renderFields(snap) {
  const fields = (snap.fields || []).slice(0, 12);
  if (!fields.length) return "(none)";
  return fields
    .map(
      (f) =>
        `- ${f.type} "${f.label || f.name || "?"}"${f.required ? " (required)" : ""}${f.filled ? " [filled]" : ""}${f.selector ? ` sel=${f.selector}` : ""}`,
    )
    .join("\n");
}

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
export async function planNextAction(context, snap, history, fillResult, classification = null) {
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

  // Preferences gate: location, desired title, salary — never skip or dismiss.
  if (hasPreferencesGateFields(snap) && preferencesGateIncomplete(snap, fillResult)) {
    return {
      type: "smart_fill",
      target: "",
      reason: "preferences gate — fill location, title, and salary",
      source: "ai-preferences",
    };
  }

  // Registration / identity forms: prefer smart_fill with real profile — never invent names.
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
  const afford = applyAffordances(snap);
  const classInfo = classification
    ? `Classifier suggests: ${classification.step} (confidence=${classification.confidence}) — ${classification.reason}`
    : "No classification available";
  const autoSubmit = settings.auto_submit === true;

  const prompt = `You are a browser agent filling an application form. Goal: reach and fill the real form, following redirect chains across domains if needed.

Target: ${objectiveLabel(context)}
URL: ${snap.url}
Title: ${snap.title || "?"} | pageKind=${snap.pageKind}
${classInfo}
Affordances: ${JSON.stringify(afford)}
Form fields on page:
${renderFields(snap)}
Filled so far: ${fillResult?.filled?.length || 0}
Recent actions: ${recent || "none"}

ELEMENTS (numbered — reference by elementIndex):
${renderInteractives(snap)}

${applicantPromptBlock(context)}
${preferencesPromptBlock(context)}

Pick ONE next action. Return ONLY JSON (no markdown):
{
  "action": "accept_cookies" | "dismiss_overlay" | "click_apply" | "click_modal" | "upload_resume" | "smart_fill" | "click_continue" | "click_submit" | "wait" | "done" | "wait_user" | "click" | "fill" | "goto" | "press" | "scroll" | "select" | "check" | "uncheck",
  "elementIndex": 3,
  "target": "CSS selector, data-testid, or exact visible text (for click/fill when no elementIndex fits)",
  "value": "text to type (fill/select) or key name (press)",
  "url": "absolute URL (goto only)",
  "reason": "one short sentence"
}

How to choose:
- Dismiss non-form dialogs (upsell, paywall, newsletter, resume-score tease): dismiss_overlay or Skip / No thanks / Not now.
- After upload_resume succeeded, if a polish/upsell modal appears, dismiss it — do not re-upload or restart Apply.
- Prefer high-level actions when they fit; otherwise use ELEMENTS with generic primitives.
- Cross-domain apply links are normal — follow them.
- wait if the page is still loading; wait_user only for CAPTCHA, payment, or login you cannot pass.
- done ONLY when application fields are filled and a human should review${autoSubmit ? "" : "/submit"}. Never done on an untouched listing page.
${!autoSubmit ? "- Do NOT click_submit — stop with done when the form is filled so a human can submit.\n" : "- click_submit only when required fields look filled.\n"}- Never fill site-search boxes or click ads/share/cookie-settings unless required.
- If the last action FAILED, pick a different strategy.`;

  const imageBase64 = context?.vision?.screenshotBase64 || "";
  let text = await callLlm(
    imageBase64
      ? `${prompt}\n\nA screenshot of the current page is attached — use it to locate controls the element map may have missed.`
      : prompt,
    { imageBase64 },
  );
  if (!text) return null;

  try {
    text = String(text).trim();
    if (text.startsWith("```")) {
      text = text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    }
    const data = JSON.parse(text);
    const action = String(data.action || "").toLowerCase();

    if (GENERIC_ACTIONS.has(action)) {
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

    if (!HIGH_LEVEL_ACTIONS.has(action)) return null;

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
