/**
 * OTP / passcode handler — fill from IMAP / TOTP / dashboard, never smart_fill.
 */
import { attemptOtpEntry, looksLikeOtpWall } from "../inboxOtp.js";
import { detectOtpFromSnap } from "./otpDetect.js";
import { inspectPage } from "../layers/formDiscovery.js";

/**
 * @param {import('playwright').Page} page
 * @param {object} snap
 * @param {object|null} log
 * @param {{ sessionId?: string|null, context?: object|null, code?: string }} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   status: 'otp_submitted'|'wait_user'|'not_otp'|'failed',
 *   reason: string,
 *   snap?: object,
 * }>}
 */
export async function handleOtp(page, snap, log = null, opts = {}) {
  const detected = detectOtpFromSnap(snap) || { isOtp: looksLikeOtpWall(snap) };
  if (!detected.isOtp && !looksLikeOtpWall(snap)) {
    return { ok: false, status: "not_otp", reason: "not_otp_surface", snap };
  }

  log?.layer?.("otp", `handling OTP wall (${detected.reason || "otp"})`, "info");

  // Optional pre-supplied code (dashboard / Telegram already resolved into waitForManualVerifyCode).
  if (opts.code) {
    try {
      const { getRuntime } = await import("../runtime.js");
      // Reuse attemptOtpEntry path by injecting via context is awkward — fill directly.
      const digits = String(opts.code).replace(/\D/g, "");
      if (digits.length >= 4) {
        const filled = await fillDigitBoxes(page, digits, log);
        if (filled) {
          await clickOtpSubmit(page, log);
          const after = await inspectPage(page).catch(() => snap);
          return { ok: true, status: "otp_submitted", reason: "code_supplied", snap: after };
        }
      }
    } catch (err) {
      log?.layer?.("otp", `supplied code fill failed: ${err?.message || err}`, "warn");
    }
  }

  const ok = await attemptOtpEntry(page, snap, log, {
    sessionId: opts.sessionId ?? null,
    context: opts.context ?? null,
  });

  const after = await inspectPage(page).catch(() => snap);
  if (ok) {
    return { ok: true, status: "otp_submitted", reason: "otp_filled", snap: after };
  }

  // attemptOtpEntry returns false on timeout / cancel — clean handoff.
  return {
    ok: false,
    status: "wait_user",
    reason: "otp_required",
    snap: after,
  };
}

async function fillDigitBoxes(page, digits, log) {
  const boxes = page.locator(
    'input[maxlength="1"], input[autocomplete="one-time-code"], input[inputmode="numeric"], input[aria-label*="digit" i], input[aria-label*="code" i]',
  );
  const n = await boxes.count().catch(() => 0);
  if (n >= 4 && digits.length >= n) {
    for (let i = 0; i < Math.min(n, digits.length); i += 1) {
      await boxes.nth(i).fill(digits[i], { timeout: 3000 }).catch(() => {});
    }
    log?.layer?.("otp", `filled ${Math.min(n, digits.length)} digit boxes`, "info");
    return true;
  }
  const single = page
    .locator('input[autocomplete="one-time-code"], input[maxlength="6"], input[name*="otp" i], input[name*="code" i]')
    .first();
  if ((await single.count().catch(() => 0)) > 0) {
    await single.fill(digits, { timeout: 5000 });
    log?.layer?.("otp", "filled single OTP input", "info");
    return true;
  }
  return false;
}

async function clickOtpSubmit(page, log) {
  const btn = page
    .locator('button, [role="button"], input[type="submit"]')
    .filter({ hasText: /verify|continue|submit|confirm/i })
    .first();
  if ((await btn.count().catch(() => 0)) > 0 && (await btn.isVisible().catch(() => false))) {
    await btn.click({ timeout: 5000 }).catch(() => {});
    log?.layer?.("otp", "clicked verify/continue", "info");
  }
}
