import { humanPause } from "../human.js";
import { gotoWithCloudflareRetry } from "../cloudflare.js";
import { loadSiteLearnings } from "../siteLearnings.js";
import { inspectPage } from "./formDiscovery.js";
import { clickCandidate } from "./domActions.js";
import { waitAfterClickTransition } from "./pageReady.js";
import {
  analyzePageIntent,
  COMMON_SUBMIT_PATHS,
  entryCandidateKey,
  normalizeHost,
  rankEntryCandidates,
  targetHostFromContext,
} from "./pageIntent.js";

export function getTriedEntryKeys(history = []) {
  return new Set(
    history
      .filter((h) => h.action === "click_apply" && h.entryKey)
      .map((h) => h.entryKey),
  );
}

export function enrichContextWithLearnings(context, hostname) {
  const host = normalizeHost(hostname);
  const hosts = loadSiteLearnings();
  const learned = hosts[host] || {};
  return {
    ...context,
    targetHost: context.targetHost || host,
    siteLearnings: learned,
    controlSkills: learned.controlSkills || [],
    avoidEntryKeys: [
      ...(context.avoidEntryKeys || []),
      ...(learned.avoidEntryKeys || []),
    ],
  };
}

export async function probeSubmitPaths(page, targetHost, log, context = {}) {
  const host = normalizeHost(targetHost);
  if (!host) return { ok: false };

  const origin = `https://${host}`;
  for (const submitPath of COMMON_SUBMIT_PATHS) {
    const url = `${origin}${submitPath}`;
    try {
      log.layer("nav_recovery", `probing ${url}`, "debug");
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 14000 });
      await humanPause(500, 900);
      const snap = await inspectPage(page);
      const intent = analyzePageIntent(snap, { ...context, targetHost: host, submitUrl: url });
      const looksGood =
        !intent.wrongPage &&
        (intent.onSubmitSurface ||
          (snap.fieldCount || 0) >= 1 ||
          snap.authForm ||
          /\/(submit|add|post|suggest)/i.test(snap.url || ""));
      if (looksGood) {
        log.layer("nav_recovery", `probe success: ${url}`, "info");
        return { ok: true, url, snap };
      }
    } catch {
      /* try next path */
    }
  }
  return { ok: false };
}

export async function clickRankedEntry(page, snap, log, layer, context = {}, { skipKeys = new Set() } = {}) {
  const ranked = rankEntryCandidates(snap.entryCandidates, context).filter(
    (c) => !skipKeys.has(c.entryKey || entryCandidateKey(c)),
  );

  if (!ranked.length) {
    log.layer(layer, "entry: no untried candidates", "debug");
    return { ok: false };
  }

  log.layer(layer, `entry: trying ${ranked.length} ranked candidate(s)`, "info");
  for (const c of ranked) {
    if (await clickCandidate(page, c, log, layer, "entry")) {
      return { ok: true, candidate: c, entryKey: c.entryKey || entryCandidateKey(c) };
    }
    if (await clickCandidate(page, c, log, layer, "entry-force", { force: true })) {
      return { ok: true, candidate: c, entryKey: c.entryKey || entryCandidateKey(c) };
    }
  }
  return { ok: false };
}

/**
 * Detect bad navigation and try back → next link → path probe → direct submit URL.
 */
export async function recoverFromWrongNavigation(page, snap, context, history, log, { sessionId = null } = {}) {
  const ctx = enrichContextWithLearnings(context, snap?.hostname);
  const intent = analyzePageIntent(snap, ctx);
  if (!intent.wrongPage && intent.onSubmitSurface) return { recovered: false };

  const isClearlyWrong = intent.wrongPage || (intent.signals.includes("feed_not_submit") && intent.score < 10);
  if (!isClearlyWrong) return { recovered: false };

  log.layer("nav_recovery", `wrong surface: ${intent.wrongReason || intent.textSample} — fixing nav`, "warn");

  const tried = getTriedEntryKeys(history);

  try {
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 12000 });
    await humanPause(500, 900);
  } catch {
    /* may already be at start */
  }

  let freshSnap = await inspectPage(page);
  const retry = await clickRankedEntry(page, freshSnap, log, "nav_recovery", ctx, { skipKeys: tried });
  if (retry.ok) {
    await waitAfterClickTransition(page);
    freshSnap = await inspectPage(page);
    const afterIntent = analyzePageIntent(freshSnap, ctx);
    if (!afterIntent.wrongPage) {
      return { recovered: true, snap: freshSnap, action: "retry_entry", entryKey: retry.entryKey };
    }
    tried.add(retry.entryKey);
    try {
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 });
      await humanPause(400, 700);
    } catch {
      /* ignore */
    }
  }

  if (ctx.submitUrl) {
    log.layer("nav_recovery", `goto submitUrl ${ctx.submitUrl}`, "info");
    await gotoWithCloudflareRetry(page, ctx.submitUrl, { sessionId });
    await humanPause(600, 1000);
    freshSnap = await inspectPage(page);
    if (!analyzePageIntent(freshSnap, ctx).wrongPage) {
      return { recovered: true, snap: freshSnap, action: "goto_submit_url" };
    }
  }

  const probe = await probeSubmitPaths(page, intent.targetHost, log, ctx);
  if (probe.ok) {
    return { recovered: true, snap: probe.snap, action: "probe_path", url: probe.url };
  }

  return { recovered: false, reason: intent.wrongReason };
}

export function shouldAttemptNavRecovery(plan, snapAfter, context, history) {
  if (!["click_apply", "click_signup", "click_continue"].includes(plan?.type)) return false;
  // Static fixtures / unset navigations — never probe live submit paths
  const url = snapAfter?.url || "";
  if (!url || /^(about:blank|data:)/i.test(url)) return false;

  const ctx = enrichContextWithLearnings(context, snapAfter?.hostname);
  const intent = analyzePageIntent(snapAfter, ctx);
  if (intent.wrongPage) return true;
  if (plan.type === "click_apply" && intent.signals.includes("feed_not_submit") && (snapAfter.fieldCount || 0) < 2) {
    return true;
  }
  const last = history[history.length - 1];
  if (last?.action === "click_apply" && last.ok && !last.progress) return true;
  return false;
}
