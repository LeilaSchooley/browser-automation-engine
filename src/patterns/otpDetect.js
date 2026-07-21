/**
 * OTP / email-SMS passcode surface detector (snap-first).
 * Used by page-role routing so digit boxes never go through smart_fill.
 */

import { TWO_FACTOR_TEXT } from "./blocked.js";

const OTP_BODY =
  /\b(enter (the )?(code|passcode|verification code|6[- ]?digit)|we (just )?sent (a |you )?(code|passcode)|we've sent you a (pass)?code|check your (email|inbox)|one[- ]time code|otp|passcode|resend code)\b/i;

/**
 * Count dedicated digit / OTP inputs on the snap.
 * @param {object} snap
 */
export function countOtpDigitFields(snap) {
  const fields = snap?.fields || [];
  return fields.filter((f) => {
    const t = `${f.type || ""} ${f.label || ""} ${f.name || ""} ${f.placeholder || ""} ${f.autocomplete || ""}`.toLowerCase();
    return (
      /code digit|digit \d+ of \d+|one[-_]?time|otp|totp|passcode|verification.?code/i.test(t) ||
      String(f.autocomplete || "").toLowerCase() === "one-time-code" ||
      (f.maxLength === 1 && /code|digit|otp/i.test(t)) ||
      (f.maxLength === 6 && /code|otp|pass/i.test(t))
    );
  }).length;
}

/**
 * Snap-only OTP / passcode modal detection.
 * @param {object} snap
 * @returns {{ isOtp: boolean, reason: string, digitFields: number }}
 */
export function detectOtpFromSnap(snap) {
  if (!snap) return { isOtp: false, reason: "no_snap", digitFields: 0 };

  const digitFields = countOtpDigitFields(snap);
  // Dribbble / multi-box passcode UIs — enough alone.
  if (digitFields >= 4) {
    return { isOtp: true, reason: `otp_digit_boxes:${digitFields}`, digitFields };
  }

  const blob = `${snap.title || ""} ${snap.pageText || ""} ${snap.headings || ""}`.toLowerCase();
  const bodyHit = OTP_BODY.test(blob) || TWO_FACTOR_TEXT.test(blob);
  const hasCodeish = (snap.fields || []).some((f) => {
    const t = `${f.type || ""} ${f.label || ""} ${f.name || ""} ${f.autocomplete || ""} ${f.placeholder || ""}`.toLowerCase();
    return (
      /otp|one[-_]?time|totp|verification|security.?code|passcode|code digit/i.test(t) ||
      String(f.autocomplete || "").toLowerCase() === "one-time-code" ||
      f.type === "tel" ||
      (f.type === "text" && /code/.test(t))
    );
  });

  if (bodyHit && (hasCodeish || digitFields >= 1)) {
    return { isOtp: true, reason: "otp_body_and_input", digitFields };
  }
  if (bodyHit && (snap.fieldCount || 0) >= 1 && (snap.fieldCount || 0) <= 8 && (snap.passwordFieldCount || 0) === 0) {
    return { isOtp: true, reason: "otp_body_short_form", digitFields };
  }

  return { isOtp: false, reason: "no_otp", digitFields };
}

/**
 * Live-page enrichment when snap is thin (optional).
 * @param {import('playwright').Page} page
 */
export async function isOtpModal(page) {
  if (!page) return false;
  try {
    const hit = await page.evaluate(() => {
      const body = (document.body?.innerText || "").slice(0, 2000).toLowerCase();
      const inputs = [...document.querySelectorAll("input")].filter((el) => {
        const ml = el.getAttribute("maxlength") || "";
        const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
        const mode = (el.getAttribute("inputmode") || "").toLowerCase();
        const aria = `${el.getAttribute("aria-label") || ""} ${el.name || ""} ${el.id || ""}`.toLowerCase();
        return (
          ac === "one-time-code" ||
          mode === "numeric" ||
          ml === "1" ||
          ml === "6" ||
          /otp|code|passcode|digit/.test(aria)
        );
      });
      const textSignals = [
        /enter (the )?(code|passcode|verification code|6-digit)/.test(body),
        /we (just )?sent (a |you )?(code|passcode)/.test(body),
        /we've sent you a (pass)?code/.test(body),
        /check your (email|inbox)|one-time code|\botp\b|passcode|resend code/.test(body),
      ].filter(Boolean).length;
      return { textSignals, inputCount: inputs.length };
    });
    return hit.textSignals >= 1 && hit.inputCount >= 1;
  } catch {
    return false;
  }
}
