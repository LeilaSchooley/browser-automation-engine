/**
 * Vision / AI fallback when heuristics cannot decide.
 */
import { getRuntime, getSettings } from "../runtime.js";
import { ariaContextBlock, shouldAttachAriaSnapshot } from "./ariaDistill.js";
import { buildAgentContext } from "./agentContext.js";
import { preferencesSignupSubmitted } from "../heuristics.js";
import { isDismissAffordanceSignature, affordanceSignature } from "../siteLearnings.js";

export async function attemptVisionFallback(page, context, snap, history, fillResult, classification, log) {
  const settings = getSettings();
  if (settings.vision_fallback_enabled === false) return null;
  if (!settings.agent_ai && !settings.vision_fallback_enabled) return null;

  const { planNextAction } = getRuntime();
  if (!planNextAction) {
    log?.layer("vision", "no planNextAction hooked — skip vision fallback", "debug");
    return null;
  }

  try {
    let screenshotBase64 = "";
    if (settings.vision_include_screenshot !== false) {
      const buf = await page.screenshot({ type: "jpeg", quality: 55, fullPage: false });
      screenshotBase64 = buf.toString("base64");
    }
    const agentCtx = await buildAgentContext(snap, fillResult, page);
    const ariaBlock = shouldAttachAriaSnapshot(snap) ? await ariaContextBlock(page, snap) : "";
    const enrichedContext = {
      ...context,
      vision: {
        screenshotBase64,
        url: snap?.url,
        title: snap?.title,
        pageText: (snap?.pageText || "").slice(0, 800),
      },
      ariaSnapshot: ariaBlock,
      layoutBlock: agentCtx.layoutBlock,
      pageState: agentCtx.pageState,
    };
    const plan = await planNextAction(enrichedContext, snap, history, fillResult, classification, page);
    if (plan) {
      if (preferencesSignupSubmitted(history) && plan.type === "act" && Number.isInteger(plan.elementIndex)) {
        const item = (snap?.interactives || []).find((i) => i.index === plan.elementIndex);
        const sig = item ? affordanceSignature(item) : null;
        if (sig && isDismissAffordanceSignature(sig)) {
          log?.layer("vision", "vision plan blocked — dismiss after preferences signup → verify_email", "warn");
          return {
            type: "verify_email",
            reason: "account activation after preferences signup — poll inbox",
            source: "vision-fallback",
          };
        }
      }
      log?.layer("vision", `vision plan: ${plan.type} — ${plan.reason || ""}`, "info");
      return plan;
    }
  } catch (err) {
    log?.layer("vision", `vision fallback failed: ${err.message}`, "warn");
  }
  return null;
}
