/**
 * Directory listing / submit-entry patterns — site-agnostic.
 */

export const LISTING_ENTRY_TEXT =
  /\b(submit|add listing|add your|list your|post your|suggest|get listed|add tool|submit startup|submit listing|add startup)\b/i;

export const SUBMIT_PAGE_TEXT =
  /\b(submit|add listing|add your|list your|post your|suggest|share your startup|get listed|submit startup|submit url|new submission)\b/i;

/** Surfaces that look like the wrong product (jobs, accelerators, feeds). */
export const WRONG_PAGE_TEXT =
  /\b(apply to yc|y combinator batch|accelerator program|upload resume|work experience|job application|employee benefits|we're hiring)\b/i;

export const NEWS_FEED_TEXT = /\b(points?|comments?|discuss|hour ago|minutes ago|upvote)\b/i;

export const SUBMIT_PATH_RE = /\/(submit|add|post|suggest|list|launch)/i;

/** Common relative paths to probe when recovering toward a submit form. */
export const COMMON_SUBMIT_PATHS = [
  "/submit",
  "/add",
  "/post",
  "/suggest",
  "/list",
  "/launch",
  "/submit-startup",
  "/get-listed",
  "/add-listing",
  "/submit-url",
];

/** Job-board apply language (listingMode=false). */
export const APPLY_TEXT =
  /\b(apply|interested|easy apply|quick apply|start application|submit application)\b/i;
