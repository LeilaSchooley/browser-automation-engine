/**
 * Detect dead Playwright sessions so stop/apply can exit instead of hanging.
 */

export function isBrowserSessionGone(page) {
  if (!page) return true;
  try {
    if (typeof page.isClosed === "function" && page.isClosed()) return true;
  } catch {
    return true;
  }
  try {
    const ctx = typeof page.context === "function" ? page.context() : null;
    const browser = ctx && typeof ctx.browser === "function" ? ctx.browser() : null;
    if (browser && typeof browser.isConnected === "function" && !browser.isConnected()) return true;
  } catch {
    return true;
  }
  return false;
}

/** True when Playwright reports the target/browser was closed mid-op. */
export function isBrowserClosedError(err) {
  if (err?.code === "BROWSER_CLOSED") return true;
  const msg = String(err?.message || err || "");
  return /Target page, context or browser has been closed|has been closed|Target closed|Browser closed|browser has been disconnected|Connection closed|Session closed|ECONNRESET|WebSocket error/i.test(
    msg,
  );
}

/**
 * Race a long Playwright/Stagehand call against a session-gone / stop probe.
 * Resolves with the work result, or rejects with a browser-closed error so callers exit.
 * Does not cancel the underlying work — only unblocks the await.
 */
export async function raceUntilGone(work, { isGone = null, intervalMs = 400 } = {}) {
  const promise = Promise.resolve().then(() => work);
  if (typeof isGone !== "function") return promise;

  let settled = false;
  let timer = null;

  const poll = new Promise((_, reject) => {
    const tick = () => {
      if (settled) return;
      try {
        if (isGone()) {
          settled = true;
          if (timer) clearInterval(timer);
          const err = new Error("Browser closed");
          err.code = "BROWSER_CLOSED";
          reject(err);
          return;
        }
      } catch {
        settled = true;
        if (timer) clearInterval(timer);
        const err = new Error("Browser closed");
        err.code = "BROWSER_CLOSED";
        reject(err);
      }
    };
    timer = setInterval(tick, Math.max(100, intervalMs));
    tick();
  });

  try {
    return await Promise.race([
      promise.finally(() => {
        settled = true;
        if (timer) clearInterval(timer);
      }),
      poll,
    ]);
  } finally {
    settled = true;
    if (timer) clearInterval(timer);
  }
}
