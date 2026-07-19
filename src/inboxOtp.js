/**
 * Soft OTP / email-code path — IMAP digit poll + manual paste + field fill.
 */
import { getSettings } from "./runtime.js";
import { isImapConfigured } from "./manualVerifyLink.js";
import { normalizeVerifyCode, waitForManualVerifyCode } from "./manualVerifyCode.js";
import { TWO_FACTOR_TEXT } from "./patterns/blocked.js";
import { resolveTotpCode } from "./totp.js";

const OTP_INTENT =
  /\b(verification code|verify code|one[- ]time|otp|security code|login code|enter the code|enter (your )?code|code from your email|authenticator)\b/i;

const OTP_CODE_NEAR =
  /(?:code|otp|pin|passcode)[^\d]{0,40}(\d{4,8})\b|\b(\d{4,8})\b[^\d]{0,40}(?:code|otp|pin|passcode)/i;

/**
 * Soft OTP wall: verification-code UI with an on-page input (not CAPTCHA-only).
 * Prefer this over hard-stopping on TWO_FACTOR_TEXT when a code field is fillable.
 */
export function looksLikeOtpWall(snap) {
  if (!snap) return false;
  const blob = `${snap.title || ""} ${snap.pageText || ""} ${snap.headings || ""}`.toLowerCase();
  if (!TWO_FACTOR_TEXT.test(blob) && !OTP_INTENT.test(blob)) return false;
  // Need a fillable identity/code field (or few fields on a login-ish page).
  const fields = snap.fields || [];
  const hasCodeish = fields.some((f) => {
    const t = `${f.type || ""} ${f.label || ""} ${f.name || ""} ${f.autocomplete || ""}`.toLowerCase();
    return (
      /otp|one[-_]?time|totp|verification|security.?code|passcode/.test(t) ||
      f.type === "tel" ||
      (f.type === "text" && /code/.test(t))
    );
  });
  if (hasCodeish) return true;
  // Passwordless verify screens often expose a single text field.
  if ((snap.fieldCount || 0) >= 1 && (snap.fieldCount || 0) <= 2 && (snap.passwordFieldCount || 0) === 0) {
    return OTP_INTENT.test(blob) || /enter the code|verify code|from your email/.test(blob);
  }
  return false;
}

/**
 * Optional IMAP fetch for a 4–8 digit code from recent mail.
 */
export async function pollVerifyCode({ hostFilter = "", timeoutMs = 20000 } = {}) {
  const settings = getSettings();
  if (settings.otp_verify_enabled === false) return null;
  if (settings.email_verify_enabled === false && settings.otp_verify_enabled !== true) return null;

  const user = process.env.EMAIL_IMAP_USER || settings.email_imap_user || "";
  const pass = process.env.EMAIL_IMAP_PASS || settings.email_imap_pass || "";
  const host = process.env.EMAIL_IMAP_HOST || settings.email_imap_host || "";
  if (!user || !pass || !host) return null;

  let ImapFlow;
  try {
    ({ ImapFlow } = await import("imapflow"));
  } catch {
    return null;
  }

  const client = new ImapFlow({
    host,
    port: Number(process.env.EMAIL_IMAP_PORT || settings.email_imap_port || 993),
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  const deadline = Date.now() + timeoutMs;
  const hostNeedle = String(hostFilter || "")
    .replace(/^www\./, "")
    .toLowerCase();

  try {
    await client.connect();
    await client.mailboxOpen("INBOX");
    while (Date.now() < deadline) {
      const lock = await client.getMailboxLock("INBOX");
      try {
        const since = new Date(Date.now() - 15 * 60 * 1000);
        for await (const msg of client.fetch({ since }, { source: true, envelope: true })) {
          const subject = String(msg.envelope?.subject || "");
          const raw = msg.source?.toString?.() || "";
          const combined = `${subject}\n${raw}`;
          if (!OTP_INTENT.test(combined) && !TWO_FACTOR_TEXT.test(combined)) continue;
          if (hostNeedle && !combined.toLowerCase().includes(hostNeedle) && !subject.toLowerCase().includes("code")) {
            // Still allow generic verification emails without host mention.
          }
          const near = combined.match(OTP_CODE_NEAR);
          const code = normalizeVerifyCode(near?.[1] || near?.[2] || "");
          if (code) return code;
          // Fallback: first 6-digit run in subject, then body.
          const subCode = normalizeVerifyCode(subject.match(/\b(\d{6})\b/)?.[1] || "");
          if (subCode) return subCode;
          const bodyCode = normalizeVerifyCode(raw.match(/\b(\d{6})\b/)?.[1] || "");
          if (bodyCode && OTP_INTENT.test(combined)) return bodyCode;
        }
      } finally {
        lock.release();
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  } catch {
    return null;
  } finally {
    try {
      await client.logout();
    } catch {
      /* ignore */
    }
  }
  return null;
}

async function fillOtpField(page, code, log) {
  const selectors = [
    'input[autocomplete="one-time-code"]',
    'input[name*="otp" i]',
    'input[id*="otp" i]',
    'input[name*="code" i]',
    'input[id*="code" i]',
    'input[aria-label*="code" i]',
    'input[placeholder*="code" i]',
    'input[type="tel"]',
    'input[type="text"]',
    'input[type="number"]',
  ];

  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      if ((await loc.count()) === 0) continue;
      if (!(await loc.isVisible({ timeout: 800 }).catch(() => false))) continue;
      await loc.fill("");
      await loc.fill(code);
      log?.layer("otp", `filled code into ${sel}`, "info");
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

async function submitOtp(page, log) {
  const buttons = [
    'button:has-text("Verify")',
    'button:has-text("Verify Code")',
    'button:has-text("Continue")',
    'button:has-text("Submit")',
    'button:has-text("Confirm")',
    'input[type="submit"]',
  ];
  for (const sel of buttons) {
    const loc = page.locator(sel).first();
    try {
      if ((await loc.count()) === 0) continue;
      if (!(await loc.isVisible({ timeout: 500 }).catch(() => false))) continue;
      await loc.click({ timeout: 5000 });
      log?.layer("otp", `clicked submit ${sel}`, "info");
      return true;
    } catch {
      /* try next */
    }
  }
  // Enter key as last resort
  try {
    await page.keyboard.press("Enter");
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve OTP (IMAP → manual paste), fill the code field, and submit.
 */
export async function attemptOtpEntry(page, snap, log, { sessionId = null, context = null } = {}) {
  if (!looksLikeOtpWall(snap)) {
    // Still allow if caller already classified enter_otp
    const blob = `${snap?.title || ""} ${snap?.pageText || ""}`;
    if (!TWO_FACTOR_TEXT.test(blob) && !OTP_INTENT.test(blob)) return false;
  }

  log?.layer("otp", "OTP wall — resolving verification code", "info");
  const host = (snap.hostname || "").replace(/^www\./, "");
  const settings = getSettings();

  // Authenticator TOTP when enabled + secret stored on site account.
  let code = resolveTotpCode(context || {}, host);
  if (code) {
    log?.layer("otp", "using TOTP from site account secret", "info");
  }

  const imapTimeout = settings.otp_verify_timeout_ms || settings.email_verify_timeout_ms || 25000;
  if (!code) code = await pollVerifyCode({ hostFilter: host, timeoutMs: imapTimeout });
  const imapConfigured = isImapConfigured();
  const imapFailed = imapConfigured && !code;

  if (!code && sessionId != null) {
    const manualTimeout = settings.otp_verify_manual_timeout_ms || settings.email_verify_manual_timeout_ms || 600_000;
    const message = imapFailed
      ? "Couldn't find the verification code via IMAP — paste the code from your email below."
      : imapConfigured
        ? "Waiting for verification code — paste it below if it doesn't arrive automatically."
        : "Verification code required — paste the code from your email below.";
    log?.layer(
      "otp",
      imapConfigured
        ? "IMAP found no code — waiting for manual OTP in dashboard"
        : "no IMAP configured — waiting for manual OTP in dashboard",
      "info",
    );
    try {
      code = await waitForManualVerifyCode(sessionId, {
        timeoutMs: manualTimeout,
        message,
        imapFailed,
      });
    } catch (err) {
      log?.layer("otp", `manual OTP not provided (${err.message})`, "warn");
      return false;
    }
  }

  if (!code) {
    log?.layer("otp", "no verification code found (configure EMAIL_IMAP_* or paste code in dashboard)", "warn");
    return false;
  }

  const filled = await fillOtpField(page, code, log);
  if (!filled) {
    log?.layer("otp", "could not find OTP input field", "warn");
    return false;
  }

  await submitOtp(page, log);
  return true;
}
