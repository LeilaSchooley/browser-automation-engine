/**
 * Manual OTP / email-code paste fallback when IMAP is missing or fails.
 */
import { getRuntime, getSettings } from "./runtime.js";
import { isImapConfigured } from "./manualVerifyLink.js";

/** @type {Map<string, { resolve: (code: string) => void, reject: (err: Error) => void, timer: ReturnType<typeof setTimeout> }>} */
const pending = new Map();
/** Codes pasted before the engine starts waiting. */
const queued = new Map();

export function hasPendingManualVerifyCode(sessionId) {
  return sessionId != null && pending.has(String(sessionId));
}

export function cancelManualVerifyCode(sessionId, reason = "cancelled") {
  const key = String(sessionId);
  queued.delete(key);
  const entry = pending.get(key);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(key);
  entry.reject(new Error(reason));
  return true;
}

/**
 * Wait for the user to paste a verification code in the host app UI.
 * @param {string|number} sessionId
 */
export function waitForManualVerifyCode(sessionId, { timeoutMs = 600000, message = "", imapFailed = false } = {}) {
  const key = String(sessionId);
  const queuedCode = queued.get(key);
  if (queuedCode) {
    queued.delete(key);
    return Promise.resolve(queuedCode);
  }
  cancelManualVerifyCode(key, "replaced");

  const { onStatus } = getRuntime();
  const imapConfigured = isImapConfigured();
  const prompt =
    message ||
    (imapFailed
      ? "Couldn't read the verification code via IMAP — paste the code from your email below."
      : imapConfigured
        ? "Waiting for verification code — paste it below if IMAP doesn't find it."
        : "Verification code required — paste the code from your email below.");

  onStatus?.(key, {
    phase: "enter_otp",
    message: prompt,
    needs_user_action: true,
    needs_otp_code: true,
    imap_configured: imapConfigured,
    imap_failed: Boolean(imapFailed),
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(key);
      reject(new Error("verification code timeout"));
    }, Math.max(30_000, timeoutMs));

    pending.set(key, {
      resolve: (code) => {
        clearTimeout(timer);
        pending.delete(key);
        onStatus?.(key, {
          phase: "agent",
          message: "Entering verification code…",
          needs_user_action: false,
          needs_otp_code: false,
        });
        resolve(code);
      },
      reject: (err) => {
        clearTimeout(timer);
        pending.delete(key);
        reject(err);
      },
      timer,
    });
  });
}

/** @returns {boolean} whether a pending waiter was resolved or code was queued */
export function provideManualVerifyCode(sessionId, code) {
  const key = String(sessionId);
  const clean = normalizeVerifyCode(code);
  if (!clean) return false;

  const entry = pending.get(key);
  if (!entry) {
    queued.set(key, clean);
    return true;
  }

  entry.resolve(clean);
  return true;
}

export function normalizeVerifyCode(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  const digits = text.replace(/\D/g, "");
  if (digits.length >= 4 && digits.length <= 8) return digits;
  const match = text.match(/\b(\d{4,8})\b/);
  return match ? match[1] : "";
}

export { isImapConfigured };
