/**
 * Unified LLM context blocks — layout, fields, controls, affordance map.
 */
import { getSettings } from "../runtime.js";
import { buildPageState } from "./pageState.js";

const SOFT_CTA_HINT =
  /\b(continue|sign up|submit|next|save|salary|location|desired job|confirm|done|ok|skip|apply|upload|dismiss|thanks|interested)\b/i;

export function renderLayoutContext(pageState) {
  if (!pageState) return "";
  const lines = ["LAYOUT:"];
  const depth = pageState.dialogStackDepth || 0;
  const activeIdx = pageState.activeDialogIndex ?? -1;
  if (depth > 0) {
    const active = pageState.dialogStack[activeIdx] || pageState.dialogStack[0];
    const title = active?.title || "dialog";
    lines.push(`- Active dialog: "${title}" (stack ${activeIdx + 1}/${depth})`);
  }
  lines.push(`- Phase: ${pageState.uiPhase || "idle"}`);
  if (pageState.pickerOpen) lines.push("- Picker: open");
  if (pageState.pendingCommits?.length) {
    for (const p of pageState.pendingCommits) {
      lines.push(`- Pending: ${p}`);
    }
  }
  if (pageState.confirmAffordances?.length) {
    const confirms = pageState.confirmAffordances
      .slice(0, 4)
      .map((c) => `${c.text || "?"} (score ${c.score || 0})`)
      .join(", ");
    lines.push(`- Confirm buttons in active dialog: [${confirms}]`);
  }
  if (pageState.customControls?.length) {
    const ctrlLines = pageState.customControls
      .slice(0, 6)
      .map((c) => {
        const val = c.liveValue || (c.filled ? "committed" : "?");
        const status = c.filled ? "committed" : "uncommitted";
        return `${c.mappedTo}="${val}" (${status})`;
      })
      .join("; ");
    lines.push(`- Custom controls: ${ctrlLines}`);
  }
  if (pageState.activeFrame) {
    lines.push(`- Active frame: ${pageState.activeFrame}`);
  }
  return `\n${lines.join("\n")}\n`;
}

export function renderFieldsAndControls(snap, pageState = null) {
  const fields = (snap?.fields || []).slice(0, 14);
  const controls = pageState?.customControls || snap?.customControls || [];
  const lines = [];
  if (fields.length) {
    lines.push("Fields:");
    for (const f of fields) {
      const wt = f.widgetType ? ` widget=${f.widgetType}` : "";
      lines.push(
        `  - ${f.type} "${f.label || f.name || "?"}"${f.required ? " (required)" : ""}${f.filled ? " [filled]" : ""}${wt}`,
      );
    }
  }
  if (controls.length) {
    lines.push("Custom controls:");
    for (const c of controls) {
      const live = c.liveValue !== undefined ? c.liveValue : c.text || "";
      lines.push(
        `  - ${c.mappedTo || c.type} "${c.label || "?"}" ${c.filled ? "[filled]" : "[empty]"} live="${live || "?"}"`,
      );
    }
  }
  return lines.length ? lines.join("\n") : "(no fields)";
}

/**
 * Rank interactives for the planner prompt — modal / high-z first.
 * Soft CTA keywords only boost ranking; they never gate inclusion.
 */
export function rankInteractivesForPrompt(interactives = [], limit = 56) {
  const items = [...(interactives || [])];
  items.sort((a, b) => {
    const score = (i) => {
      let s = Number(i.hintScore) || 0;
      if (i.inModal) s += 20;
      if (i.kind === "file" || String(i.kind || "").startsWith("field:")) s += 8;
      if (i.kind === "combobox" || i.role === "combobox") s += 6;
      if ((i.zIndex || 0) > 0) s += Math.min(8, Math.floor((i.zIndex || 0) / 100));
      const text = `${i.text || ""} ${i.aria || ""}`;
      if (SOFT_CTA_HINT.test(text)) s += 3;
      if (i.inNav) s -= 4;
      if (i.inFooter) s -= 6;
      if (i.disabled) s -= 20;
      return s;
    };
    return score(b) - score(a);
  });
  return items.slice(0, limit);
}

export function renderInteractivesForPrompt(snap, limit = 56) {
  const slice = rankInteractivesForPrompt(snap?.interactives || [], limit);
  if (!slice.length) return "(no element map — use high-level actions)";
  return slice
    .map((i) => {
      const flags = [
        i.inModal ? "modal" : "",
        i.inNav ? "nav" : "",
        i.disabled ? "disabled" : "",
        i.hintScore ? `hint=${i.hintScore}` : "",
        i.learned ? "learned" : "",
      ]
        .filter(Boolean)
        .join(",");
      const bbox =
        i.bbox && Number.isFinite(i.bbox.x)
          ? ` @(${i.bbox.x},${i.bbox.y},${i.bbox.w}x${i.bbox.h})`
          : "";
      return `#${i.index} [${i.kind}/${i.tag}] "${i.text || i.aria || "?"}"${flags ? ` (${flags})` : ""}${bbox}`;
    })
    .join("\n");
}

/** Soft regex-ranked candidates — hints only, not exclusive click targets. */
export function renderSoftHints(snap) {
  const lines = [];
  const push = (label, list) => {
    const top = (list || []).slice(0, 3).map((c) => `"${c.text || c.aria || c.testId || "?"}"`).join(", ");
    if (top) lines.push(`- ${label}: ${top}`);
  };
  push("entry", snap?.entryCandidates);
  push("modal", snap?.modalCandidates);
  push("dismiss", snap?.dismissCandidates);
  push("continue", snap?.continueCandidates);
  push("confirm", snap?.confirmCandidates);
  if (!lines.length) return "";
  return `\nSOFT HINTS (regex priors — prefer ELEMENTS by index when they conflict):\n${lines.join("\n")}\n`;
}

/** Compact CDP perception refs for the planner (when page_perception_enabled). */
export function renderPerceptionRefs(snap, limit = 12) {
  const refs = snap?._perception?.refs || [];
  if (!refs.length) return "";
  const lines = refs.slice(0, limit).map((r) => {
    const label = String(r.label || r.name || r.role || "?").slice(0, 40);
    return `  ${r.refId || r.id}: ${r.role || "node"} "${label}"`;
  });
  return `\nPERCEPTION REFS (stable a11y ids — prefer when choosing clicks):\n${lines.join("\n")}\n`;
}

/**
 * @param {object} snap
 * @param {object} [fillResult]
 * @param {import('playwright').Page} [page]
 */
export async function buildAgentContext(snap, fillResult = null, page = null) {
  const settings = getSettings();
  if (settings.layout_context_enabled === false) {
    const pageState = {
      uiPhase: "idle",
      dialogStack: [],
      dialogStackDepth: 0,
      pendingCommits: [],
      confirmAffordances: [],
      customControls: snap?.customControls || [],
    };
    return {
      pageState,
      layoutBlock: "",
      fieldsBlock: renderFieldsAndControls(snap, pageState),
      interactivesBlock: renderInteractivesForPrompt(snap),
      softHintsBlock: renderSoftHints(snap),
      perceptionRefsBlock: renderPerceptionRefs(snap),
    };
  }
  const pageState = await buildPageState(snap, page, fillResult);
  return {
    pageState,
    layoutBlock: renderLayoutContext(pageState),
    fieldsBlock: renderFieldsAndControls(snap, pageState),
    interactivesBlock: renderInteractivesForPrompt(snap),
    softHintsBlock: renderSoftHints(snap),
    perceptionRefsBlock: renderPerceptionRefs(snap),
  };
}
