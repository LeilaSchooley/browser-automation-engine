/**
 * Cookie / consent banner patterns.
 */

export const COOKIE_TEXT =
  /\b(accept all cookies|accept cookies|accept all|allow all|allow cookies|agree|got it)\b/i;

export const COOKIE_BANNER_SELECTORS =
  "#onetrust-banner-sdk, #onetrust-consent-sdk, [id*='cookie' i][role='dialog'], [class*='cookie' i][role='dialog']";
