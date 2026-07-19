/**
 * Manual email-verification link fallback when IMAP is missing or fails.
 */
import { getRuntime, getSettings } from "./runtime.js";

/** @type {Map<string, { resolve: (link: string) => void, reject: (err: Error) => void, timer: ReturnType<typeof setTimeout> }>} */
const pending = new Map();
/** Verification links pasted before the engine starts waiting (for example from Bulk Apply). */
const queued = new Map();

export function isImapConfigured() {
  const settings = getSettings();
  const user = process.env.EMAIL_IMAP_USER || settings.email_imap_user || "";
  const pass = process.env.EMAIL_IMAP_PASS || settings.email_imap_pass || "";
  const host = process.env.EMAIL_IMAP_HOST || settings.email_imap_host || "";
  return Boolean(user && pass && host);
}

export function hasPendingManualVerifyLink(sessionId) {
  return sessionId != null && pending.has(String(sessionId));
}

export function cancelManualVerifyLink(sessionId, reason = "cancelled") {
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
 * Wait for the user to paste a verification URL in the host app UI.
 * @param {string|number} sessionId
 */
export function waitForManualVerifyLink(sessionId, { timeoutMs = 600000, message = "", imapFailed = false } = {}) {
  const key = String(sessionId);
  const queuedLink = queued.get(key);
  if (queuedLink) {
    queued.delete(key);
    return Promise.resolve(queuedLink);
  }
  cancelManualVerifyLink(key, "replaced");

  const { onStatus } = getRuntime();
  const imapConfigured = isImapConfigured();
  const prompt = message ||
    (imapFailed
      ? "Couldn't read the verification email via IMAP — paste the confirmation link below."
      : imapConfigured
        ? "Waiting for verification email — paste the confirmation link if IMAP doesn't find it."
        : "Email verification required — paste the confirmation link from your inbox below.");

  onStatus?.(key, {
    phase: "verify_email",
    message: prompt,
    needs_user_action: true,
    needs_verify_link: true,
    imap_configured: imapConfigured,
    imap_failed: Boolean(imapFailed),
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(key);
      reject(new Error("verification link timeout"));
    }, Math.max(30_000, timeoutMs));

    pending.set(key, {
      resolve: (link) => {
        clearTimeout(timer);
        pending.delete(key);
        onStatus?.(key, {
          phase: "agent",
          message: "Opening email verification link…",
          needs_user_action: false,
          needs_verify_link: false,
        });
        resolve(link);
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

/** @returns {boolean} whether a pending waiter was resolved */
export function provideManualVerifyLink(sessionId, link) {
  const key = String(sessionId);
  const clean = normalizeVerifyLink(link);
  if (!clean) return false;

  const entry = pending.get(key);
  if (!entry) {
    queued.set(key, clean);
    return true;
  }

  entry.resolve(clean);
  return true;
}

export function normalizeVerifyLink(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  const match = text.match(/https?:\/\/[^\s"'<>]+/i);
  return (match ? match[0] : text).replace(/[>)\]"']+$/, "");
}
