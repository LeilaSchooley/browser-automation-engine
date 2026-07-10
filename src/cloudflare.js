import { getRuntime, getSettings } from "./runtime.js";

const MARKERS = [
  "performing security verification",
  "just a moment",
  "checking your browser",
  "verify you are human",
  "security verification",
  "cf-challenge",
  "challenge-platform",
  "turnstile",
  "ray id",
];

export async function isCloudflarePage(page) {
  try {
    const url = (page.url() || "").toLowerCase();
    if (url.includes("challenges.cloudflare.com")) {
      return true;
    }

    const title = ((await page.title()) || "").toLowerCase();
    const hasChallengeForm = await page
      .locator("#challenge-form, [data-cf-beacon], .cf-turnstile, iframe[src*='challenges.cloudflare.com']")
      .first()
      .isVisible()
      .catch(() => false);

    if (hasChallengeForm) return true;

    const snippet = await page.evaluate(
      () => (document.body?.innerText || document.title || "").slice(0, 2500).toLowerCase(),
    );
    const haystack = `${url} ${title} ${snippet}`;
    return MARKERS.some((marker) => haystack.includes(marker));
  } catch {
    return false;
  }
}

async function randomPause(minMs = 1000, maxMs = 3000) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  await new Promise((r) => setTimeout(r, ms));
}

export async function waitForChallengeAutoResolve(page, timeoutMs) {
  try {
    await page.waitForFunction(
      () => {
        const title = document.title.toLowerCase();
        const body = (document.body?.innerText || "").slice(0, 2000).toLowerCase();
        const blocked =
          title.includes("just a moment") ||
          body.includes("checking your browser") ||
          body.includes("performing security verification") ||
          body.includes("verify you are human");
        return !blocked;
      },
      { timeout: timeoutMs },
    );
    await randomPause(1500, 3500);
    return true;
  } catch {
    return false;
  }
}

export async function handleTurnstile(page) {
  const frame = page.frameLocator('iframe[src*="challenges.cloudflare.com"]');
  try {
    const stage = frame.locator("#challenge-stage, .ctp-checkbox-label, input[type=checkbox]").first();
    const visible = await stage.isVisible({ timeout: 3000 }).catch(() => false);
    if (visible) {
      await randomPause(800, 2000);
    }
    await stage.waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
    await randomPause(1000, 2500);
    return !(await isCloudflarePage(page));
  } catch {
    return !(await isCloudflarePage(page));
  }
}

export async function waitForCloudflareClear(page, sessionId = null) {
  const { onStatus } = getRuntime();

  if (!getSettings().cloudflare_wait_enabled) {
    return true;
  }
  if (!(await isCloudflarePage(page))) {
    return true;
  }

  const timeoutSec = Math.max(30, getSettings().cloudflare_wait_timeout_sec);
  const timeoutMs = timeoutSec * 1000;

  const update = (payload) => {
    if (sessionId) onStatus?.(sessionId, payload);
  };

  update({
    phase: "cloudflare",
    message: "Cloudflare detected — waiting for auto-verification (complete checkbox if shown)…",
    needs_user_action: true,
  });

  const autoResolved = await waitForChallengeAutoResolve(page, Math.min(timeoutMs, 45000));
  if (autoResolved && !(await isCloudflarePage(page))) {
    update({
      phase: "verified",
      message: "Cloudflare verification passed — continuing…",
      needs_user_action: false,
    });
    return true;
  }

  await handleTurnstile(page);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isCloudflarePage(page))) {
      update({
        phase: "verified",
        message: "Verification passed — continuing…",
        needs_user_action: false,
      });
      return true;
    }
    await page.waitForTimeout(2000);
  }

  update({
    phase: "cloudflare_timeout",
    message: "Cloudflare wait timed out — finish verification manually in the browser window.",
    needs_user_action: true,
  });
  return false;
}

export async function gotoWithCloudflareRetry(page, url, { sessionId = null, maxRetries = 2 } = {}) {
  const { humanGoto } = await import("./human.js");

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    await humanGoto(page, url);
    if (!(await isCloudflarePage(page))) {
      return true;
    }
    const cleared = await waitForCloudflareClear(page, sessionId);
    if (cleared && !(await isCloudflarePage(page))) {
      return true;
    }
    if (attempt < maxRetries) {
      await page.waitForTimeout(2000);
    }
  }
  return !(await isCloudflarePage(page));
}
