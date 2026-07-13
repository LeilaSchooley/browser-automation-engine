/**
 * Modal / wizard / continue / submit control patterns.
 * Re-exports shared confirm patterns from controlPatterns.
 */
export {
  PICKER_CONFIRM_PATTERNS,
  CONFIRM_TEXT,
  CONFIRM_TEXT_STRICT,
  BEHAVIORAL_BUTTON_SEL,
} from "../primitives/controlPatterns.js";

/** Strict — avoid matching "Next.js" in job descriptions via bare \bnext\b */
export const CONTINUE_TEXT =
  /\b(continue|proceed|save and continue|sign up with email|continue with email|next step)\b/i;

export const MODAL_STEP_TEXT =
  /\b(I have a resume|I need a resume|upload resume|use my resume|select file|choose file|sign up with email|continue with email|get started)\b/i;

export const SUBMIT_TEXT = /\b(submit|send application|apply now|complete application)\b/i;

/** Visible actionable nodes for the affordance map (behavioral, not site-specific). */
export const INTERACTIVE_SEL =
  "button, a[href], [role='button'], [role='link'], input[type='submit'], input[type='file'], input[type='checkbox'], input[type='radio'], select, textarea, [data-testid], [data-test], [class*='cursor-pointer' i], [class*='ds-button' i], [class*='btn' i]";

export const MODAL_WAIT_SEL =
  "[role='dialog'], [aria-modal='true'], .modal, .ui-modal, [data-testid*='modal' i]";
