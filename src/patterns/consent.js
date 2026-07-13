/**
 * Cookie / consent banner patterns.
 */

export const COOKIE_TEXT =
  /\b(accept all cookies|accept cookies|accept all|allow all|allow cookies|agree|got it)\b|^consent$/i;

export const COOKIE_BANNER_SELECTORS =
  "#onetrust-banner-sdk, #onetrust-consent-sdk, .fc-consent-root, [class*='fc-consent'], [id*='cookie' i][role='dialog'], [class*='cookie' i][role='dialog']";

/** Known third-party consent roots — not generic dialogs. */
export const STRUCTURAL_COOKIE_SELECTORS =
  "#onetrust-banner-sdk, #onetrust-consent-sdk, .fc-consent-root, [class*='fc-consent-root']";

export const FUNDING_CHOICES_ROOT_SEL = ".fc-consent-root, [class*='fc-consent-root']";

/** Popups that look banner-like but are not cookie consent. */
export const NON_COOKIE_POPUP_BODY =
  /receive the latest jobs|be the first to know|setemail alert|job alert|sign up for updates|newsletter|get job alerts|time for a new job|candidates have already subscribed|get new relevant jobs|subscribe and receive new vacancies|new vacancies|jdJbeAlertPopUp|phlexPopup|phlexOverlay/i;
