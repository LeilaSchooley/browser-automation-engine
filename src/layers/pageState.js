/**
 * Unified page layout state — dialog stack, picker phase, pending commits.
 */
import { hasPreferencesGateFields, preferencesGateIncomplete } from "../fillPreferences.js";
import { hasIdentityRegistrationFields } from "../fillProfile.js";
import { readLiveControlValue } from "../fillCustomControls.js";
import { PLACEHOLDER_RE } from "../primitives/controlPatterns.js";

function inferWorkflowKind(snap) {
  if (!snap) return "unknown";
  if (hasPreferencesGateFields(snap)) return "preferences_gate";
  if (hasIdentityRegistrationFields(snap) || snap.pageKind === "auth") return "auth";
  if (snap.hasApplyModal && (snap.modalStepCount || 0) > 0) return "wizard";
  if (snap.hasBlockingOverlay) return "overlay";
  if (snap.pageKind === "form") return "form";
  return snap.pageKind || "unknown";
}

function inferDialogRole(entry, snap, index) {
  if (entry.inApplyModal) return "apply";
  const title = (entry.title || "").toLowerCase();
  if (/salary|compensation|location|picker|select/i.test(title)) return "picker";
  if (snap.pickerOpen && index === 0) return "picker";
  if (snap.hasBlockingOverlay && index === 0) return "overlay";
  return "dialog";
}

function buildDialogStack(snap) {
  const raw = snap?.dialogStack || [];
  return raw.map((d, i) => ({
    index: i,
    title: d.title || "",
    selector: d.selector || "",
    zIndex: d.zIndex || 0,
    role: inferDialogRole(d, snap, i),
    inApplyModal: !!d.inApplyModal,
  }));
}

function buildConfirmAffordances(snap) {
  return (snap?.confirmCandidates || []).slice(0, 8).map((c, i) => ({
    text: c.text || c.aria || "",
    selector: c.selector || "",
    dialogIndex: c.inModal ? 0 : -1,
    score: c.score || 0,
    index: i,
  }));
}

function buildOpenPickers(snap, pageStateControls) {
  if (!snap?.pickerOpen && !(snap?.dialogStack || []).length) return [];
  const pickers = [];
  for (const c of pageStateControls) {
    if (c.widgetType !== "combobox" && c.mappedTo !== "salary") continue;
    if (c.filled && c.liveValue) continue;
    pickers.push({
      triggerLabel: c.label,
      triggerSelector: c.selector || c.triggerSelector || "",
      optionCount: 0,
      selectedText: c.liveValue || "",
      confirmButtons: buildConfirmAffordances(snap).map((a) => a.text).filter(Boolean),
    });
  }
  if (pickers.length === 0 && snap?.pickerOpen) {
    pickers.push({
      triggerLabel: "picker",
      triggerSelector: "",
      optionCount: 0,
      selectedText: "",
      confirmButtons: buildConfirmAffordances(snap).map((a) => a.text).filter(Boolean),
    });
  }
  return pickers;
}

async function detectUncommittedSelection(page) {
  try {
    const hasSelected = await page
      .locator(
        "[role='listbox'] [role='option'][aria-selected='true'], [role='option'].selected, [role='option'][data-selected='true']",
      )
      .first()
      .isVisible({ timeout: 400 })
      .catch(() => false);
    return hasSelected;
  } catch {
    return false;
  }
}

async function buildCustomControls(snap, page) {
  const controls = (snap?.customControls || []).map((c) => ({
    mappedTo: c.mappedTo || c.type || "custom",
    label: c.label || "",
    widgetType: c.widgetType || "combobox",
    filled: !!c.filled,
    liveValue: "",
    needsConfirm: c.mappedTo === "salary" || c.requiresConfirm,
    selector: c.selector || c.triggerSelector || "",
  }));

  if (page) {
    for (const ctrl of controls) {
      if (ctrl.mappedTo === "salary") {
        ctrl.liveValue = await readLiveControlValue(page, "salary");
        ctrl.filled = !!(ctrl.liveValue && !PLACEHOLDER_RE.test(ctrl.liveValue));
      } else if (ctrl.mappedTo === "location") {
        ctrl.liveValue = await readLiveControlValue(page, "location");
        ctrl.filled = !!(ctrl.liveValue && !PLACEHOLDER_RE.test(ctrl.liveValue));
      } else if (ctrl.mappedTo === "desiredtitle") {
        ctrl.liveValue = await readLiveControlValue(page, "desiredtitle");
        ctrl.filled = !!(ctrl.liveValue && !PLACEHOLDER_RE.test(ctrl.liveValue));
      }
    }
  }
  return controls;
}

function derivePendingCommits(snap, controls, uiPhase, confirmAffordances) {
  const pending = [];
  if (uiPhase === "option_selected_uncommitted") {
    const topConfirm = confirmAffordances[0]?.text || "Save";
    pending.push(`Selection made but not committed — click "${topConfirm}" or equivalent confirm button`);
  }
  if (uiPhase === "picker_open") {
    pending.push("Picker is open — select an option then confirm if required");
  }
  for (const c of controls) {
    if (c.mappedTo === "salary" && !c.filled) {
      pending.push(`Salary: ${c.liveValue ? "value not committed" : "field shows ? or placeholder"}`);
    }
  }
  if (hasPreferencesGateFields(snap) && preferencesGateIncomplete(snap)) {
    if (!pending.some((p) => /salary/i.test(p))) {
      const salaryCtrl = controls.find((c) => c.mappedTo === "salary");
      if (salaryCtrl && !salaryCtrl.filled) pending.push("Salary expectations not committed");
    }
  }
  return [...new Set(pending)];
}

/**
 * @param {object} snap
 * @param {import('playwright').Page} [page]
 * @param {object} [fillResult]
 */
export async function buildPageState(snap, page = null, fillResult = null) {
  const dialogStack = buildDialogStack(snap);
  const customControls = await buildCustomControls(snap, page);
  const confirmAffordances = buildConfirmAffordances(snap);
  const openPickers = buildOpenPickers(snap, customControls);

  let uiPhase = "idle";
  const hasUnfilledCustom = customControls.some((c) => !c.filled);
  const salaryUncommitted = customControls.some((c) => c.mappedTo === "salary" && !c.filled);

  if (snap?.pickerOpen) {
    uiPhase = "picker_open";
    if (page && salaryUncommitted && (await detectUncommittedSelection(page))) {
      uiPhase = "option_selected_uncommitted";
    }
  } else if (hasUnfilledCustom && hasPreferencesGateFields(snap)) {
    if (page && salaryUncommitted && (await detectUncommittedSelection(page))) {
      uiPhase = "option_selected_uncommitted";
    } else {
      uiPhase = "picker_open";
    }
  } else if (
    hasPreferencesGateFields(snap) &&
    !preferencesGateIncomplete(snap, fillResult) &&
    customControls.every((c) => c.filled || c.mappedTo !== "salary")
  ) {
    uiPhase = "ready_to_continue";
  } else if (!hasUnfilledCustom && (snap?.customControlCount || 0) === 0) {
    uiPhase = "idle";
  }

  const pendingCommits = derivePendingCommits(snap, customControls, uiPhase, confirmAffordances);
  const workflowKind = inferWorkflowKind(snap);

  return {
    workflow: {
      kind: workflowKind,
      title: snap?.applyModalTitle || snap?.title || "",
      blocked: pendingCommits.length > 0 || preferencesGateIncomplete(snap, fillResult),
    },
    dialogStack,
    activeDialogIndex: snap?.activeDialogIndex ?? (dialogStack.length > 0 ? 0 : -1),
    uiPhase,
    openPickers,
    customControls,
    confirmAffordances,
    pendingCommits,
    pickerOpen: !!snap?.pickerOpen,
    dialogStackDepth: dialogStack.length,
    activeFrame: snap?.activeFrame || null,
  };
}

/** Sync snapshot of layout fields for affordances (no live reads). */
export function pageStateSummary(snap) {
  const dialogStack = buildDialogStack(snap);
  const customControls = (snap?.customControls || []).map((c) => ({
    mappedTo: c.mappedTo || c.type || "custom",
    filled: !!c.filled,
  }));
  const hasUnfilledCustom = customControls.some((c) => !c.filled);
  const salaryUncommitted = customControls.some((c) => c.mappedTo === "salary" && !c.filled);

  let uiPhase = "idle";
  if (snap?.pickerOpen) {
    uiPhase = "picker_open";
  } else if (hasUnfilledCustom && hasPreferencesGateFields(snap)) {
    uiPhase = salaryUncommitted ? "picker_open" : "picker_open";
  } else if (
    hasPreferencesGateFields(snap) &&
    !preferencesGateIncomplete(snap) &&
    customControls.every((c) => c.filled || c.mappedTo !== "salary")
  ) {
    uiPhase = "ready_to_continue";
  }

  const pendingCommits = [];
  if (uiPhase === "picker_open" && salaryUncommitted) {
    pendingCommits.push("Salary expectations not committed");
  }

  return {
    dialogStackDepth: dialogStack.length,
    pickerOpen: !!snap?.pickerOpen,
    uiPhase,
    pendingCommits,
    confirmCount: snap?.confirmCount || 0,
    activeDialogIndex: snap?.activeDialogIndex ?? (dialogStack.length > 0 ? 0 : -1),
  };
}
