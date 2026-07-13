/**
 * Unified dialog / popover scoping — one API for modal clicks, picker confirm, fill.
 */

const DIALOG_SEL =
  "[role='dialog'][aria-modal='true'], [role='dialog'], .modal, [aria-modal='true'], [data-testid*='modal' i]";

const POPOVER_SEL =
  "[role='listbox'], [data-popper-placement], [class*='popover' i], [class*='dropdown-menu' i]";

/**
 * @param {import('playwright').Page} page
 * @param {object} [snap]
 * @param {"click_wizard"|"confirm_picker"|"fill_parent"|"dismiss_overlay"|"aria_snapshot"} intent
 */
export function resolveDialogScope(page, snap, intent = "click_wizard") {
  const stack = snap?.dialogStack || [];

  if (intent === "confirm_picker") {
    if (snap?.pickerOpen && stack.length > 0) {
      const pickerEntry = stack.find((d) => /salary|compensation|picker|select/i.test(d.title || "")) || stack[0];
      if (pickerEntry?.selector) {
        return page.locator(pickerEntry.selector).first();
      }
      return page.locator(DIALOG_SEL).first();
    }
    const popover = page.locator(POPOVER_SEL).last();
    return popover;
  }

  if (intent === "fill_parent") {
    const applyEntry = [...stack].reverse().find((d) => d.inApplyModal) || stack[stack.length - 1];
    if (applyEntry?.selector) return page.locator(applyEntry.selector).first();
    if (stack.length > 0 && stack[stack.length - 1]?.selector) {
      return page.locator(stack[stack.length - 1].selector).first();
    }
    return page.locator(DIALOG_SEL).first();
  }

  if (intent === "dismiss_overlay") {
    if (stack.length > 0 && stack[0]?.selector) {
      return page.locator(stack[0].selector).first();
    }
    return page.locator(DIALOG_SEL).first();
  }

  if (intent === "aria_snapshot") {
    if (snap?.pickerOpen) {
      return page.locator(DIALOG_SEL).first();
    }
    const applyEntry = [...stack].reverse().find((d) => d.inApplyModal);
    if (applyEntry?.selector) return page.locator(applyEntry.selector).first();
    return page.locator(DIALOG_SEL).first();
  }

  // click_wizard — outermost apply modal
  const applyEntry = [...stack].reverse().find((d) => d.inApplyModal);
  if (applyEntry?.selector) return page.locator(applyEntry.selector).first();
  return page.locator(DIALOG_SEL).first();
}

/** @param {import('playwright').Page} page @param {object} [snap] */
export function resolveOptionScope(page, snap) {
  const dialogScope = resolveDialogScope(page, snap, "confirm_picker");
  return dialogScope;
}

/** @param {import('playwright').Page} page @param {object} [snap] */
export function resolvePopoverScope(page, snap) {
  if (snap?.pickerOpen) {
    const scoped = resolveDialogScope(page, snap, "confirm_picker");
    return scoped;
  }
  const popover = page.locator(POPOVER_SEL).last();
  return popover;
}

/**
 * @param {import('playwright').Page} page
 * @param {string} [frameSelector]
 */
export function resolveFrameScope(page, frameSelector) {
  if (!frameSelector) return page;
  try {
    return page.frameLocator(frameSelector);
  } catch {
    return page;
  }
}
