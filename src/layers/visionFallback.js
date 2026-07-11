/**
 * Vision / AI fallback when heuristics cannot decide.
 * Uses runtime.planNextAction when VISION_FALLBACK_ENABLED and agent_ai.
 */
import { getRuntime, getSettings } from "../runtime.js";

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
    const enrichedContext = {
      ...context,
      vision: {
        screenshotBase64,
        url: snap?.url,
        title: snap?.title,
        pageText: (snap?.pageText || "").slice(0, 800),
      },
    };
    const plan = await planNextAction(enrichedContext, snap, history, fillResult, classification);
    if (plan) {
      log?.layer("vision", `vision plan: ${plan.type} — ${plan.reason || ""}`, "info");
      return plan;
    }
  } catch (err) {
    log?.layer("vision", `vision fallback failed: ${err.message}`, "warn");
  }
  return null;
}
