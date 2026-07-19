/**
 * Vision / AI fallback when heuristics cannot decide.
 */
import { getRuntime, getSettings } from "../runtime.js";
import { ariaContextBlock, shouldAttachAriaSnapshot } from "./ariaDistill.js";
import { buildAgentContext } from "./agentContext.js";
import { preferencesSignupSubmitted } from "../heuristics.js";
import { isDismissAffordanceSignature, affordanceSignature } from "../siteLearnings.js";

/**
 * Optional CUA-style coordinate click when DOM+Stagehand already failed twice.
 * Requires settings.cua_vision_enabled and an LLM that returns {x,y}.
 */
async function attemptCuaCoordinateAct(page, context, snap, history, log) {
  const settings = getSettings();
  if (settings.cua_vision_enabled !== true) return null;
  const recentFails = (history || []).slice(-4).filter((h) => !h.ok || !h.progress).length;
  if (recentFails < 2) return null;
  const { callLlm } = getRuntime();
  if (typeof callLlm !== "function") return null;

  try {
    const buf = await page.screenshot({ type: "jpeg", quality: 50, fullPage: false });
    const prompt =
      `You are a computer-use agent. Given this job-apply page screenshot, return ONE click ` +
      `to advance the application (not social login, not mailto). ` +
      `Return ONLY JSON: {"x":123,"y":456,"reason":"short"}. Page: ${snap?.url || ""}`;
    const text = await callLlm(prompt, { imageBase64: buf.toString("base64") });
    const match = String(text || "").match(/\{[\s\S]*\}/);
    const data = JSON.parse(match ? match[0] : text);
    const x = Number(data.x);
    const y = Number(data.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    await page.mouse.click(x, y);
    log?.layer("vision", `CUA coordinate click at (${x},${y}) — ${data.reason || ""}`, "info");
    return {
      type: "act",
      action: "click",
      reason: `cua vision click — ${data.reason || `${x},${y}`}`,
      source: "cua-vision",
      ok: true,
    };
  } catch (err) {
    log?.layer("vision", `CUA vision failed: ${err.message}`, "warn");
    return null;
  }
}

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
    // Last-resort CUA coordinates after repeated no-progress (flagged).
    const cuaPlan = await attemptCuaCoordinateAct(page, context, snap, history, log);
    if (cuaPlan) return cuaPlan;

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
        compressed: agentCtx.compressedObservationBlock || "",
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
