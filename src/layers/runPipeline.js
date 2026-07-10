import { getSettings } from "../runtime.js";
import { isCloudflarePage, waitForCloudflareClear, gotoWithCloudflareRetry } from "../cloudflare.js";
import { humanPause } from "../human.js";
import { runSmartFill } from "../smartFill.js";
import { runAutomationAgent } from "./automationAgent.js";
import { preparePageForApply } from "./pagePrep.js";
import { inspectPage, logPageSnapshot } from "./formDiscovery.js";
import { waitForApplySurface } from "./pageReady.js";

function buildReadyMessage({ fillResult, snap, prep, agentSteps, entryLabel = "Apply" }) {
  const filledCount = fillResult.filled?.length || 0;
  const fieldCount = snap.fieldCount || 0;

  if (filledCount > 0) {
    return `Filled ${filledCount} field(s) after ${agentSteps || "?"} agent steps — review and submit in the browser.`;
  }
  if (fieldCount > 0) {
    return `${fieldCount} field(s) visible but auto-fill matched none — check agent log and complete manually.`;
  }
  if (snap.pageKind === "listing" && snap.entryCount > 0) {
    const label = snap.entryCandidates?.[0]?.text || entryLabel;
    if (prep?.actions?.includes("entry")) {
      return `Clicked "${label}" — complete registration or next step in the browser.`;
    }
    return `Listing page — click "${label}" in the browser to continue (agent could not click it).`;
  }
  if (snap.pageKind === "modal") {
    return "Modal open — complete the step in the browser window.";
  }
  if (snap.continueCount > 0) {
    return "Multi-step flow — click Continue/Next in the browser to proceed.";
  }
  return "Agent finished — complete remaining steps in the browser.";
}

/**
 * Unified automation pipeline — navigation then dynamic agent loop.
 */
export async function runPipeline(page, { url, context = {}, log, sessionId = null, shouldStop = null, entryLabel = "Apply" } = {}) {
  if (!url) throw new Error("runPipeline requires url");

  log.step("navigate", `Loading ${url}`);
  await gotoWithCloudflareRetry(page, url, { sessionId });
  await humanPause(800, 1500);

  const afterNav = await waitForApplySurface(page, log, { timeoutMs: 28000 });
  logPageSnapshot(log, afterNav, "navigate");
  log.layer("navigate", `loaded ${page.url()}`, "info");

  if (await isCloudflarePage(page)) {
    log.layer("cloudflare", "challenge detected — waiting", "warn");
    await waitForCloudflareClear(page, sessionId);
  }

  let agentResult;
  if (getSettings().agent_enabled) {
    agentResult = await runAutomationAgent(page, context, log, { url, sessionId, shouldStop });
  } else {
    log.step("page_prep", "Linear prep (agent disabled)…");
    const prep = await preparePageForApply(page, url, log);
    const fillResult = await runSmartFill(page, context, log, { sessionId });
    const snap = await inspectPage(page);
    agentResult = {
      prep,
      fillResult,
      snap,
      history: [],
      agentSteps: 0,
    };
  }

  const { prep, fillResult, snap, history, agentSteps } = agentResult;

  log.layer(
    "agent",
    `summary: steps=${agentSteps} filled=${fillResult.filled?.length || 0} kind=${snap.pageKind} fields=${snap.fieldCount}`,
    "info",
  );

  if (fillResult.unfilled?.length) {
    for (const u of fillResult.unfilled.slice(0, 15)) {
      const hint = u.label || u.name || u.placeholder || u.selector || "?";
      log.layer("smart_fill", `unfilled: ${u.type || "?"} "${hint}" score=${u.score ?? "?"}`, "debug");
    }
  }

  if (history?.length) {
    const trail = history.map((h) => h.action).join(" → ");
    log.layer("agent", `trail: ${trail}`, "debug");
  }

  const readyMessage = buildReadyMessage({ fillResult, snap, prep, agentSteps, entryLabel });

  return {
    prep,
    fillResult,
    snap,
    readyMessage,
    cloudflare: await isCloudflarePage(page),
    agentSteps,
    agentHistory: history,
  };
}

export { buildReadyMessage };
