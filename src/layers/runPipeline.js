import { getSettings } from "../runtime.js";
import { isCloudflarePage, waitForCloudflareClear, gotoWithCloudflareRetry } from "../cloudflare.js";
import { humanPause } from "../human.js";
import { runSmartFill } from "../smartFill.js";
import { runAutomationAgent } from "./automationAgent.js";
import { preparePageForApply } from "./pagePrep.js";
import { inspectPage, logPageSnapshot } from "./formDiscovery.js";
import { waitForApplySurface } from "./pageReady.js";
import { enrichContextWithLearnings } from "./navigationRecovery.js";

/** Prefer a concrete submit path over a bare homepage when provided. */
export function resolveStartUrl(url, submitUrl) {
  if (!url) return url;
  if (!submitUrl || submitUrl === url) return url;
  try {
    const target = new URL(submitUrl);
    const base = new URL(url);
    const sameHost = target.hostname.replace(/^www\./, "") === base.hostname.replace(/^www\./, "");
    if (!sameHost) return url;
    if (target.pathname && target.pathname !== "/") return submitUrl;
    if (/\/(submit|add|post|suggest|list|launch)/i.test(target.pathname)) return submitUrl;
  } catch {
    /* ignore */
  }
  return url;
}

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
export async function runPipeline(page, { url, submitUrl, context = {}, log, sessionId = null, shouldStop = null, entryLabel = "Apply" } = {}) {
  if (!url) throw new Error("runPipeline requires url");

  const startUrl = resolveStartUrl(url, submitUrl || context?.submitUrl);
  if (startUrl !== url) {
    log.layer("navigate", `using submit URL ${startUrl}`, "info");
  }

  log.step("navigate", `Loading ${startUrl}`);
  await gotoWithCloudflareRetry(page, startUrl, { sessionId });
  await humanPause(800, 1500);

  const afterNav = await waitForApplySurface(page, log, { timeoutMs: 28000 });
  logPageSnapshot(log, afterNav, "navigate");
  log.layer("navigate", `loaded ${page.url()}`, "info");

  if (await isCloudflarePage(page)) {
    log.layer("cloudflare", "challenge detected — waiting", "warn");
    await waitForCloudflareClear(page, sessionId);
  }

  const agentContext = enrichContextWithLearnings(
    {
      ...context,
      startUrl: url,
      submitUrl,
      targetHost: (() => {
        try {
          return new URL(submitUrl || url).hostname;
        } catch {
          return "";
        }
      })(),
    },
    (() => {
      try {
        return new URL(submitUrl || url).hostname;
      } catch {
        return "";
      }
    })(),
  );

  let agentResult;
  if (getSettings().agent_enabled) {
    agentResult = await runAutomationAgent(page, agentContext, log, {
      url: startUrl,
      submitUrl: submitUrl || context?.submitUrl,
      sessionId,
      shouldStop,
    });
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
  const activePage = agentResult.page || page;

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
    cloudflare: await isCloudflarePage(activePage),
    agentSteps,
    agentHistory: history,
    page: activePage,
  };
}

export { buildReadyMessage };
