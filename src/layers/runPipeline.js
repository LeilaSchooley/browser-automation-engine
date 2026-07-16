import { getRuntime, getSettings } from "../runtime.js";
import { isCloudflarePage, waitForCloudflareClear, gotoWithCloudflareRetry } from "../cloudflare.js";
import { humanPause } from "../human.js";
import { runSmartFill } from "../smartFill.js";
import { runAutomationAgent } from "./automationAgent.js";
import { preparePageForApply } from "./pagePrep.js";
import { inspectPage, logPageSnapshot } from "./formDiscovery.js";
import { waitForApplySurface } from "./pageReady.js";
import { enrichContextWithLearnings } from "./navigationRecovery.js";
import { closeStagehand } from "./stagehandAdapter.js";
import { initEventLog, recordEngineEvent, resetLlmMetrics } from "../observability.js";
import { resetPagePerception } from "./pagePerception.js";
import { attachNetworkSkillCapture, tryDirectoryApiFastPath } from "../networkSkills.js";
import { normalizeHost } from "../host.js";
import { isBlankOrNewTabUrl, preferAtsWorkingPage, pruneExtraPages } from "./tabHygiene.js";

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

function buildReadyMessage({ fillResult, snap, prep, agentSteps, agentHistory = [], entryLabel = "Apply" }) {
  const filledCount = fillResult.filled?.length || 0;
  const fieldCount = snap.fieldCount || 0;
  const blocked = [...(agentHistory || [])]
    .reverse()
    .find((h) => h.applyStep === "blocked" || h.action === "wait_user" && h.reason);

  if (blocked?.reason) {
    if (/closed|unavailable|similar jobs only|recommended substitutes/i.test(blocked.reason)) {
      return `Skipped — ${blocked.reason}. Not applying to substitute listings.`;
    }
    if (/aggregator|mirror|unreachable|suspicious|dead/i.test(blocked.reason)) {
      return `Blocked — ${blocked.reason}. This listing is not a real employer apply page.`;
    }
    return `Stopped — ${blocked.reason}. Complete manually only if this is a real apply site.`;
  }

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
 * @param {object} opts
 * @param {boolean} [opts.resumeFromCurrentPage] — skip goto; continue from the open tab (AdsPower resume).
 */
export async function runPipeline(page, { url, submitUrl, context = {}, log, sessionId = null, shouldStop = null, entryLabel = null, resumeFromCurrentPage = false } = {}) {
  if (!url) throw new Error("runPipeline requires url");

  let networkCapture = null;
  let workingPage = page;
  try {
  resetPagePerception();
  resetLlmMetrics();
  if (sessionId) initEventLog(sessionId);
  recordEngineEvent("pipeline_start", { url, sessionId, resumeFromCurrentPage: !!resumeFromCurrentPage });
  const startUrl = resolveStartUrl(url, submitUrl || context?.submitUrl);
  if (startUrl !== url) {
    log.layer("navigate", `using submit URL ${startUrl}`, "info");
  }

  const settings = getSettings();
  const activeProfile = getRuntime().profile;
  const activeEntryLabel = entryLabel || activeProfile?.entryLabel || "Apply";
  if (settings.network_skills_enabled || settings.listing_mode || process.env.NETWORK_SKILLS_ENABLED === "1") {
    try {
      networkCapture = attachNetworkSkillCapture(workingPage, {
        hostname: normalizeHost(startUrl),
        log,
      });
    } catch {
      networkCapture = null;
    }
    await tryDirectoryApiFastPath(
      { url: startUrl, targetHost: normalizeHost(startUrl) },
      {
        intent:
          settings.workflow_intent ||
          activeProfile?.intent ||
          (settings.listing_mode ? "submit_listing" : "submit_application"),
        log,
      },
    ).catch(() => {});
  }

  // Prefer an employer ATS tab when resuming a multi-tab AdsPower profile.
  if (resumeFromCurrentPage) {
    try {
      const preferred = await preferAtsWorkingPage(workingPage.context(), workingPage);
      if (preferred) workingPage = preferred;
      await pruneExtraPages(workingPage.context(), workingPage, { log, maxPages: 3 }).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  let currentUrl = "";
  try {
    currentUrl = workingPage.url() || "";
  } catch {
    currentUrl = "";
  }
  const canResume =
    resumeFromCurrentPage &&
    /^https?:/i.test(currentUrl) &&
    !isBlankOrNewTabUrl(currentUrl);

  if (canResume) {
    log.step("navigate", `Resuming on open page ${currentUrl.slice(0, 140)}`);
    log.layer("navigate", "skip goto — continuing from current browser tab", "info");
  } else {
    if (resumeFromCurrentPage) {
      log.layer("navigate", "resume requested but no live page — loading apply URL", "warn");
    }
    log.step("navigate", `Loading ${startUrl}`);
    await gotoWithCloudflareRetry(workingPage, startUrl, { sessionId });
    await humanPause(800, 1500);
  }

  const afterNav = await waitForApplySurface(workingPage, log, { timeoutMs: 28000 });
  logPageSnapshot(log, afterNav, "navigate");
  log.layer("navigate", `loaded ${workingPage.url()}`, "info");

  if (await isCloudflarePage(workingPage)) {
    log.layer("cloudflare", "challenge detected — waiting", "warn");
    await waitForCloudflareClear(workingPage, sessionId);
  }

  const agentStartUrl = canResume ? workingPage.url() : startUrl;
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
    agentResult = await runAutomationAgent(workingPage, agentContext, log, {
      url: agentStartUrl,
      submitUrl: submitUrl || context?.submitUrl,
      sessionId,
      shouldStop,
    });
  } else {
    log.step("page_prep", "Linear prep (agent disabled)…");
    const prep = await preparePageForApply(workingPage, url, log);
    const fillResult = await runSmartFill(workingPage, context, log, { sessionId });
    const snap = await inspectPage(workingPage);
    agentResult = {
      prep,
      fillResult,
      snap,
      history: [],
      agentSteps: 0,
    };
  }

  const { prep, fillResult, snap, history, agentSteps } = agentResult;
  const activePage = agentResult.page || workingPage;

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

  const readyMessage = buildReadyMessage({
    fillResult,
    snap,
    prep,
    agentSteps,
    agentHistory: history,
    entryLabel: activeEntryLabel,
  });

  recordEngineEvent("pipeline_end", {
    sessionId,
    agentSteps,
    filled: fillResult.filled?.length || 0,
    pageKind: snap.pageKind,
    resumed: canResume,
  });

  return {
    prep,
    fillResult,
    snap,
    readyMessage,
    cloudflare: await isCloudflarePage(activePage),
    agentSteps,
    agentHistory: history,
    page: activePage,
    resumed: canResume,
  };
  } finally {
    try {
      networkCapture?.stop?.();
    } catch {
      /* ignore */
    }
    await closeStagehand();
  }
}

export { buildReadyMessage };
