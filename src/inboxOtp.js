/**
 * Soft OTP / email-code path — IMAP digit poll + manual paste + field fill.
 */
import { getSettings } from "./runtime.js";
import { isImapConfigured } from "./manualVerifyLink.js";
import { normalizeVerifyCode } from "./manualVerifyCode.js";
import { TWO_FACTOR_TEXT } from "./patterns/blocked.js";
import { resolveTotpCode } from "./totp.js";
import { detectOtpFromSnap } from "./patterns/otpDetect.js";

const OTP_INTENT =
  /\b(verification code|verify code|one[- ]time|otp|security code|login code|enter the code|enter (your )?code|code from your email|authenticator|passcode|we've sent you a (pass)?code|sent you a passcode)\b/i;

const OTP_CODE_NEAR =
  /(?:code|otp|pin|passcode)[^\d]{0,40}(\d{4,8})\b|\b(\d{4,8})\b[^\d]{0,40}(?:code|otp|pin|passcode)/i;

/**
 * Soft OTP wall: verification-code UI with an on-page input (not CAPTCHA-only).
 * Prefer this over hard-stopping on TWO_FACTOR_TEXT when a code field is fillable.
 */
export function looksLikeOtpWall(snap) {
  return detectOtpFromSnap(snap).isOtp;
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
  const digits = String(code || "").replace(/\D/g, "");
  if (!digits) return false;

  // Multi-box passcode (Dribbble etc.): one digit per maxlength=1 input.
  const boxes = page.locator(
    'input[maxlength="1"], input[aria-label*="digit" i], input[aria-label*="Code digit" i]',
  );
  const boxCount = await boxes.count().catch(() => 0);
  if (boxCount >= 4 && digits.length >= 4) {
    const n = Math.min(boxCount, digits.length);
    for (let i = 0; i < n; i += 1) {
      try {
        const loc = boxes.nth(i);
        if (!(await loc.isVisible({ timeout: 500 }).catch(() => false))) continue;
        await loc.fill("");
        await loc.fill(digits[i]);
      } catch {
        /* next box */
      }
    }
    log?.layer("otp", `filled ${n} digit boxes`, "info");
    return true;
  }

  const selectors = [
    'input[autocomplete="one-time-code"]',
    'input[maxlength="6"]',
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
      await loc.fill(digits);
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

async function readFilledOtpFromPage(page) {
  if (!page) return "";
  try {
    const digits = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('input[maxlength="1"], input[aria-label*="digit" i], input[aria-label*="Code digit" i]')].filter(
        (el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        },
      );
      if (boxes.length >= 4) {
        const joined = boxes.map((el) => String(el.value || "").trim()).join("");
        if (/^\d{4,8}$/.test(joined)) return joined;
      }
      const single = document.querySelector(
        'input[autocomplete="one-time-code"], input[maxlength="6"], input[name*="otp" i], input[name*="code" i]',
      );
      if (single) {
        const v = String(single.value || "").replace(/\D/g, "");
        if (v.length >= 4 && v.length <= 8) return v;
      }
      return "";
    });
    return String(digits || "");
  } catch {
    return "";
  }
}

/** True when the passcode modal is gone (user finished signup in the browser). */
async function otpModalCleared(page) {
  if (!page) return false;
  try {
    return await page.evaluate(() => {
      const body = (document.body?.innerText || "").toLowerCase().slice(0, 1500);
      const boxes = document.querySelectorAll('input[maxlength="1"], input[aria-label*="Code digit" i]');
      const visibleBoxes = [...boxes].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (visibleBoxes.length >= 4) return false;
      return !/passcode|we've sent you|enter the code|resend code/.test(body);
    });
  } catch {
    return false;
  }
}

/**
 * Wait for dashboard paste OR code already typed in the browser.
 */
async function waitForOtpFromUserOrPage(page, sessionId, opts = {}) {
  const {
    waitForManualVerifyCode,
    provideManualVerifyCode,
    completeManualVerifyFromBrowser,
    normalizeVerifyCode,
  } = await import("./manualVerifyCode.js");

  const manual = waitForManualVerifyCode(sessionId, opts);

  if (!page) return manual;

  let stopped = false;
  const pagePoll = (async () => {
    while (!stopped) {
      const fromPage = normalizeVerifyCode(await readFilledOtpFromPage(page));
      if (fromPage) {
        provideManualVerifyCode(sessionId, fromPage);
        return fromPage;
      }
      if (await otpModalCleared(page)) {
        completeManualVerifyFromBrowser(sessionId);
        return "__browser_done__";
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    return "";
  })();

  try {
    return await Promise.race([manual, pagePoll]);
  } finally {
    stopped = true;
  }
}

/**
 * Resolve OTP (IMAP → manual paste / in-browser fill), fill the code field, and submit.
 */
export async function attemptOtpEntry(page, snap, log, { sessionId = null, context = null } = {}) {
  if (!looksLikeOtpWall(snap)) {
    const blob = `${snap?.title || ""} ${snap?.pageText || ""}`;
    const digitOnly = detectOtpFromSnap(snap).digitFields >= 4;
    if (!digitOnly && !TWO_FACTOR_TEXT.test(blob) && !OTP_INTENT.test(blob)) return false;
  }

  log?.layer("otp", "OTP wall — resolving verification code", "info");
  const host = (snap.hostname || "").replace(/^www\./, "");
  const settings = getSettings();

  // Authenticator TOTP when enabled + secret stored on site account.
  let code = resolveTotpCode(context || {}, host);
  if (code) {
    log?.layer("otp", "using TOTP from site account secret", "info");
  }

  // Already typed in the browser before we started waiting.
  if (!code) {
    const existing = await readFilledOtpFromPage(page);
    if (existing) {
      code = existing;
      log?.layer("otp", "using code already typed in the browser", "info");
    }
  }

  const imapTimeout = settings.otp_verify_timeout_ms || settings.email_verify_timeout_ms || 25000;
  if (!code) code = await pollVerifyCode({ hostFilter: host, timeoutMs: imapTimeout });
  const imapConfigured = isImapConfigured();
  const imapFailed = imapConfigured && !code;

  if (!code && sessionId != null) {
    const manualTimeout = settings.otp_verify_manual_timeout_ms || settings.email_verify_manual_timeout_ms || 600_000;
    const message = imapFailed
      ? "Couldn't find the verification code via IMAP — paste the code from your email below (or type it in the browser)."
      : imapConfigured
        ? "Waiting for verification code — paste below or type it in the browser."
        : "Verification code required — paste in the dashboard or type it in the browser window.";
    log?.layer(
      "otp",
      imapConfigured
        ? "IMAP found no code — waiting for manual OTP (dashboard or browser)"
        : "no IMAP configured — waiting for manual OTP (dashboard or browser)",
      "info",
    );
    try {
      code = await waitForOtpFromUserOrPage(page, sessionId, {
        timeoutMs: manualTimeout,
        message,
        imapFailed,
      });
    } catch (err) {
      log?.layer("otp", `manual OTP not provided (${err.message})`, "warn");
      return false;
    }
  }

  if (code === "__browser_done__") {
    log?.layer("otp", "passcode modal cleared in browser — continuing", "info");
    return true;
  }

  if (!code) {
    log?.layer("otp", "no verification code found (configure EMAIL_IMAP_* or paste code in dashboard)", "warn");
    return false;
  }

  // If browser already has the full code, don't overwrite — just submit if needed.
  const already = await readFilledOtpFromPage(page);
  if (already && already === String(code).replace(/\D/g, "")) {
    log?.layer("otp", "browser already has code — submitting", "info");
    await submitOtp(page, log);
    return true;
  }

  const filled = await fillOtpField(page, code, log);
  if (!filled) {
    // User may have already submitted; treat cleared modal as success.
    if (await otpModalCleared(page)) {
      log?.layer("otp", "OTP inputs gone — assuming browser verify succeeded", "info");
      return true;
    }
    log?.layer("otp", "could not find OTP input field", "warn");
    return false;
  }

  await submitOtp(page, log);
  return true;
}
