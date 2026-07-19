/**
 * Optional CAPTCHA solver hook. Off by default.
 */
import { getSettings } from "../runtime.js";

export async function attemptCaptchaSolve(page, snap, log) {
  const settings = getSettings();
  // Opt-in only — never call external solvers unless explicitly enabled.
  if (settings.captcha_solver_enabled !== true) {
    return { ok: false, reason: "CAPTCHA solver disabled (set captcha_solver_enabled)" };
  }
  const solverUrl = settings.captcha_solver_url || process.env.CAPTCHA_SOLVER_URL || "";
  const apiKey = settings.captcha_solver_api_key || process.env.CAPTCHA_SOLVER_API_KEY || "";
  if (!solverUrl) {
    return { ok: false, reason: "CAPTCHA solver not configured (captcha_solver_url)" };
  }

  try {
    const sitekey = await page.evaluate(() => {
      const el =
        document.querySelector("[data-sitekey]") ||
        document.querySelector(".g-recaptcha") ||
        document.querySelector("[data-callback]");
      return el?.getAttribute("data-sitekey") || "";
    });
    const payload = {
      url: snap?.url || page.url(),
      sitekey,
      hostname: snap?.hostname,
      apiKey: apiKey || undefined,
    };
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(solverUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) return { ok: false, reason: `solver HTTP ${res.status}` };
    const data = await res.json();
    const token = data.token || data.solution || "";
    if (!token) return { ok: false, reason: "solver returned no token" };

    await page.evaluate((t) => {
      const area = document.querySelector("#g-recaptcha-response, textarea[name='g-recaptcha-response']");
      if (area) {
        area.value = t;
        area.dispatchEvent(new Event("input", { bubbles: true }));
      }
      if (typeof window.captchaCallback === "function") window.captchaCallback(t);
    }, token);
    log?.layer("captcha", "injected solver token", "info");
    return { ok: true };
  } catch (err) {
    log?.layer("captcha", `solver error: ${err.message}`, "warn");
    return { ok: false, reason: err.message };
  }
}
