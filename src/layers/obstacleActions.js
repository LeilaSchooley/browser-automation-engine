/**
 * Recover from generic UI obstacles: checkboxes, consent, dismiss overlays.
 */
import { humanPause } from "../human.js";
import { clickDiscoveredCookie, clickDiscoveredContinue, clickCandidate } from "./domActions.js";
import { inspectPage } from "./formDiscovery.js";
import { dismissBlockingOverlays, dismissInterstitialDialog } from "./adDismiss.js";
import { looksLikeAuthForm, looksLikeHardGate } from "./authActions.js";
import { looksLikeSignupForm } from "./signupActions.js";

const CHECKBOX_HINT =
  /\b(terms|agree|accept|confirm|privacy|newsletter|subscribe|age|robot|not a robot|remember)\b/i;
const DISMISS_HINT = /\b(got it|dismiss|close|no thanks|not now|maybe later|skip)\b/i;

export async function checkBlockingCheckboxes(page, log) {
  let checked = 0;
  try {
    const boxes = page.locator('input[type="checkbox"]');
    const count = await boxes.count();
    for (let i = 0; i < Math.min(count, 12); i += 1) {
      const box = boxes.nth(i);
      if (!(await box.isVisible({ timeout: 300 }).catch(() => false))) continue;
      if (await box.isChecked().catch(() => true)) continue;

      const meta = await box.evaluate((el) => {
        const label =
          el.labels?.[0]?.innerText ||
          el.getAttribute("aria-label") ||
          el.name ||
          el.id ||
          el.closest("label")?.innerText ||
          "";
        return `${label} ${el.name || ""} ${el.id || ""}`.toLowerCase();
      });

      const required = await box.evaluate((el) => el.required || el.getAttribute("aria-required") === "true");
      if (!required && !CHECKBOX_HINT.test(meta)) continue;

      await box.check({ timeout: 3000 }).catch(async () => {
        await box.click({ timeout: 3000 });
      });
      checked += 1;
      log?.layer("obstacle", `checked checkbox: ${meta.slice(0, 60)}`, "info");
    }
  } catch {
    /* ignore */
  }
  return checked > 0;
}

export async function clickDismissibleOverlay(page, snap, log) {
  const candidates = [
    ...(snap?.cookieCandidates || []),
    ...(snap?.continueCandidates || []).filter((c) => DISMISS_HINT.test(c.text || "")),
    ...(snap?.modalCandidates || []).filter((c) => DISMISS_HINT.test(c.text || "")),
  ];
  for (const c of candidates.slice(0, 5)) {
    if (await clickCandidate(page, c, log, "obstacle", "dismiss")) return true;
  }

  const patterns = [/got it/i, /^ok$/i, /dismiss/i, /no thanks/i, /not now/i, /skip/i];
  for (const pattern of patterns) {
    try {
      const btn = page.getByRole("button", { name: pattern }).first();
      if (await btn.isVisible({ timeout: 500 })) {
        await btn.click({ timeout: 5000 });
        log?.layer("obstacle", `clicked dismiss ${pattern}`, "info");
        return true;
      }
    } catch {
      /* next */
    }
  }
  return false;
}

/**
 * Try recoverable obstacles. Returns { ok, action, hardStop, reason }.
 */
export async function attemptObstacleRecovery(page, snap, log) {
  const hard = looksLikeHardGate(snap);
  if (hard.hard) {
    return { ok: false, hardStop: true, reason: hard.reason, action: "hard_gate" };
  }

  // Prefer dismissing upsell/interstitial dialogs (Skip / No thanks) before cookies.
  if (await dismissInterstitialDialog(page, log, "obstacle")) {
    await humanPause(400, 800);
    return { ok: true, action: "interstitial_dismiss", hardStop: false };
  }

  if (snap?.hasBlockingOverlay) {
    if (await dismissBlockingOverlays(page, log, "obstacle", snap)) {
      await humanPause(400, 800);
      return { ok: true, action: "ad_overlay", hardStop: false };
    }
  }

  if (await clickDiscoveredCookie(page, log, "obstacle", snap)) {
    await humanPause(400, 800);
    return { ok: true, action: "cookies", hardStop: false };
  }

  if (await checkBlockingCheckboxes(page, log)) {
    await humanPause(300, 600);
    return { ok: true, action: "checkbox", hardStop: false };
  }

  if (await clickDismissibleOverlay(page, snap, log)) {
    await humanPause(400, 800);
    return { ok: true, action: "dismiss", hardStop: false };
  }

  if ((snap.continueCount || 0) > 0 && !looksLikeAuthForm(snap)) {
    if (await clickDiscoveredContinue(page, log, "obstacle", snap)) {
      await humanPause(500, 900);
      return { ok: true, action: "continue", hardStop: false };
    }
  }

  if (looksLikeAuthForm(snap) || looksLikeSignupForm(snap)) {
    return { ok: false, hardStop: false, action: "needs_auth", reason: "auth wall — use signup/login" };
  }

  return { ok: false, hardStop: false, action: "none" };
}

export function pageNeedsObstaclePass(snap, fillResult) {
  if (!snap) return false;
  if (looksLikeHardGate(snap).hard) return true;
  if (snap.hasBlockingOverlay) return true;
  if (snap.cookieBanner) return true;
  if ((snap.continueCount || 0) > 0 && (fillResult?.filled?.length || 0) === 0) return true;
  return false;
}

export async function reinspectAfterObstacle(page) {
  return inspectPage(page);
}
