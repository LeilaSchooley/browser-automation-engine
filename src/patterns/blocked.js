/**
 * Hard / soft blocked surfaces (CAPTCHA, paywall, auth-required apply).
 */

export const BLOCKED_TEXT =
  /\b(sign in to apply|log in to apply|login required|create an account to apply|captcha|verify you are human|payment required|subscribe to apply)\b/i;

export const CAPTCHA_TEXT =
  /\b(captcha|recaptcha|hcaptcha|cf-turnstile|turnstile|verify you are human|are you a robot|unusual traffic|press and hold|security check|complete the security)\b/i;

export const TWO_FACTOR_TEXT =
  /\b(two[- ]factor|2fa|authenticator|enter (the )?code|sms code|one[- ]time password|otp|passcode|we've sent you a (pass)?code)\b/i;
