/**
 * Tab hygiene after clicks + host-hop retargeting for redirect chains.
 * Behavior-identical extract from automationAgent.
 */
import { adoptOpenedPage, isPageUnloaded, waitForApplySurface } from "../pageReady.js";
import { pruneExtraPages, preferAtsWorkingPage } from "../tabHygiene.js";
import { normalizeHost } from "../../host.js";
import { isAggregatorHost } from "../applyUrlSafety.js";
import { enrichContextWithLearnings } from "../navigationRecovery.js";

const ADOPT_PLAN_TYPES = [
  "click_apply",
  "click_modal",
  "click_continue",
  "click_signup",
  "click_signin",
  "act",
  "stagehand_act",
];

/**
 * After click/act: adopt target=_blank tabs, prefer ATS working page, prune extras.
 * @returns {{ page: object, ok: boolean, knownPages: Set }}
 */
export async function applyTabHygieneAfterClick({
  page,
  plan,
  snap,
  knownPages,
  log,
  step,
  ok,
} = {}) {
  let nextPage = page;
  let nextOk = ok;
  let nextKnown = knownPages;

  if (!ADOPT_PLAN_TYPES.includes(plan?.type)) {
    return { page: nextPage, ok: nextOk, knownPages: nextKnown };
  }

  let stayedPut = true;
  try {
    stayedPut = nextPage.url() === (snap.url || nextPage.url());
  } catch {
    /* ignore */
  }
  if (stayedPut) {
    const adopted = await adoptOpenedPage(nextPage, nextKnown, log);
    if (adopted) {
      nextPage = adopted;
      nextOk = true;
      await waitForApplySurface(nextPage, log, { timeoutMs: 15000 });
    }
  }
  try {
    const atsPage = await preferAtsWorkingPage(nextPage.context(), nextPage);
    if (atsPage && atsPage !== nextPage) {
      nextPage = atsPage;
      nextOk = true;
      log.layer("agent", "switched working page to employer ATS tab", "info");
    }
    nextKnown = new Set(nextPage.context().pages());
    // Periodic hygiene — never closes ATS tabs (see tabHygiene).
    if (step % 3 === 0 || plan.type === "stagehand_act") {
      await pruneExtraPages(nextPage.context(), nextPage, { log, maxPages: 2 }).catch(() => {});
    }
  } catch {
    /* ignore */
  }

  return { page: nextPage, ok: nextOk, knownPages: nextKnown };
}

/**
 * Redirect chains legitimately change hosts; retarget so entry ranking and
 * learnings follow the chain instead of fighting it.
 * Mutates agentContext in place (same as the original loop).
 *
 * @returns {{
 *   hostHops: number,
 *   aggregatorHops: number,
 *   stop: boolean,
 *   stopReason: string|null,
 *   aggregatorHost: string|null,
 * }}
 */
export function applyHostHop({
  hopAllowed,
  snapAfter,
  agentContext,
  hostHops,
  aggregatorHops,
  maxHostHops = 4,
  maxAggregatorHops = 2,
  log,
} = {}) {
  let nextHostHops = hostHops;
  let nextAggregatorHops = aggregatorHops;

  if (!hopAllowed || isPageUnloaded(snapAfter)) {
    return {
      hostHops: nextHostHops,
      aggregatorHops: nextAggregatorHops,
      stop: false,
      stopReason: null,
      aggregatorHost: null,
    };
  }

  const newHost = normalizeHost(snapAfter.hostname || snapAfter.url);
  if (newHost && agentContext.targetHost && newHost !== agentContext.targetHost) {
    nextHostHops += 1;
    if (isAggregatorHost(newHost)) {
      nextAggregatorHops += 1;
      if (nextAggregatorHops > maxAggregatorHops) {
        log.layer(
          "agent",
          `aggregator mirror chain limit (${nextAggregatorHops}) — stopping at ${newHost}`,
          "warn",
        );
        return {
          hostHops: nextHostHops,
          aggregatorHops: nextAggregatorHops,
          stop: true,
          stopReason: "aggregator_chain",
          aggregatorHost: newHost,
        };
      }
    }
    if (nextHostHops > maxHostHops) {
      log.layer("agent", `too many host hops (${nextHostHops}) — stopping chain`, "warn");
      return {
        hostHops: nextHostHops,
        aggregatorHops: nextAggregatorHops,
        stop: true,
        stopReason: "max_host_hops",
        aggregatorHost: null,
      };
    }
    log.layer("agent", `hop ${nextHostHops}: redirect chain → ${newHost}`, "info");
    const rehydrated = enrichContextWithLearnings(
      { ...agentContext, targetHost: newHost, siteLearnings: undefined, avoidEntryKeys: [] },
      newHost,
    );
    agentContext.targetHost = rehydrated.targetHost;
    agentContext.siteLearnings = rehydrated.siteLearnings;
    agentContext.avoidEntryKeys = rehydrated.avoidEntryKeys;
  }

  return {
    hostHops: nextHostHops,
    aggregatorHops: nextAggregatorHops,
    stop: false,
    stopReason: null,
    aggregatorHost: null,
  };
}
