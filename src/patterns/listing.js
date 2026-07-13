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

/** Inline job-alert / newsletter signup — not a real application form. */
export const JOB_ALERT_SIGNUP_BODY =
  /data alert|job alert|receive the latest jobs|be the first to know|email alert|get job alerts|notify me when|jobs like this|subscribe.{0,20}jobs|setemail alert|time for a new job|candidates have already subscribed|get new relevant jobs|subscribe and receive new vacancies|new vacancies/i;

/** Field names common on SEO job-board alert forms (devitjobs, etc.). */
export const JOB_ALERT_FIELD_RE =
  /personname|personemail|techcategory|alertemail|jobalertemail|subscribename/i;

/** Signals a real application form (not alert-only). */
export const APPLICATION_FIELD_RE =
  /resume|cv|cover.?letter|portfolio|linkedin|phone|mobile|salary expectation|work authorization|visa sponsorship|clearance|references|start date|notice period/i;

/** Ashby/Greenhouse-style job-board filter fields — not applicant preferences. */
export const JOB_BOARD_FILTER_FIELD_RE =
  /departmentid|employmenttype|locationid|workplacetype|jobcategory|teamid|officeid|departmentfilter|teamfilter/i;

/** Copy on company job-board index pages (not apply forms). */
export const JOB_BOARD_PAGE_BODY =
  /\bopen positions\b|\ball jobs\b|\bbrowse jobs\b|\bfilter jobs\b|\bjob openings\b|\bview all jobs\b|\bcurrent openings\b/i;

/** Aggregator listing where the original role is gone — similar-jobs redirect only. */
export const CLOSED_JOB_BODY =
  /requires local presence|view similar jobs(?:\s+below)?|similar jobs that could be interesting|this (job|position|role|vacancy) (is )?(no longer|not) (available|accepting applications)|no longer available|no longer accepting applications|job (has )?expired|position (has )?been filled|listing (is )?closed|closed job|posting (has )?closed|we.?re no longer accepting/i;

export const CLOSED_JOB_URL_RE = /[?&]closedJob=True\b|[?&]closedjob=true\b/i;

/** Major SEO aggregators — apply URLs on these hosts are mirrors, not employer ATS. */
export const SEO_AGGREGATOR_HOST_RE =
  /(^|\.)jooble\.org$|(^|\.)devitjobs\.|(^|\.)whatjobs\.|(^|\.)neuvoo\.|(^|\.)talent\.com$|(^|\.)simplyhired\.com$/i;
