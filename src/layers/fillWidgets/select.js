/**
 * Native <select> custom control fillers.
 */
import { EEOC_MAPPED } from "../../fillApplicationAnswers.js";
import { nearbyLabelText, EEOC_DECLINE_OPTION_RE } from "../../primitives/controlPatterns.js";
import {
  VISA_SELECT_NAME_RE,
  WORK_AUTH_SELECT_NAME_RE,
  REMOTE_SELECT_NAME_RE,
  RELOCATE_SELECT_NAME_RE,
} from "../../patterns/applicationScreening.js";
import { scopedDialog, visible } from "./shared.js";

export async function selectNativeOption(sel, value, log) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  const declineWanted = EEOC_DECLINE_OPTION_RE.test(raw) || /decline/i.test(raw);
  try {
    await sel.selectOption({ label: raw });
    log?.layer("custom_controls", `selected native option ${raw}`, "debug");
    return true;
  } catch {
    /* try value / soft match */
  }
  try {
    await sel.selectOption({ value: raw });
    return true;
  } catch {
    /* soft */
  }
  try {
    const options = await sel.locator("option").allTextContents();
    const match =
      options.find((t) => String(t || "").trim().toLowerCase() === raw.toLowerCase()) ||
      (declineWanted ? options.find((t) => EEOC_DECLINE_OPTION_RE.test(String(t || ""))) : null) ||
      options.find((t) => new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(String(t || "")));
    if (!match || !String(match).trim()) return false;
    await sel.selectOption({ label: String(match).trim() });
    log?.layer("custom_controls", `selected soft option ${String(match).trim().slice(0, 40)}`, "debug");
    return true;
  } catch {
    return false;
  }
}

export function mappedSelectNameRe(mappedTo) {
  const m = String(mappedTo || "").toLowerCase();
  if (m === "eeocgender") return /eeo\[?gender\]?|\bgender\b/i;
  if (m === "eeocrace") return /eeo\[?race\]?|\brace\b|ethnic/i;
  if (m === "eeocveteran") return /eeo\[?veteran\]?|veteran/i;
  if (m === "eeocdisability") return /eeo\[?disabilit|disabilit/i;
  if (m === "visasponsorship") return VISA_SELECT_NAME_RE;
  if (m === "workauthorization") return WORK_AUTH_SELECT_NAME_RE;
  if (m === "remotepreference") return REMOTE_SELECT_NAME_RE;
  if (m === "willingtorelocate") return RELOCATE_SELECT_NAME_RE;
  return null;
}

export async function fillSelectControl(page, specOrLabelRe, value, log, snap = null) {
  if (!value) return false;
  const spec =
    specOrLabelRe && typeof specOrLabelRe === "object" && !(specOrLabelRe instanceof RegExp)
      ? specOrLabelRe
      : { labelRe: specOrLabelRe };
  const labelRe = spec.labelRe instanceof RegExp ? spec.labelRe : null;
  const mappedTo = String(spec.mappedTo || "").toLowerCase();
  const nameRe = mappedSelectNameRe(mappedTo);
  const scope = scopedDialog(page, snap, "fill_parent");
  const root = (await scope.count().catch(() => 0)) > 0 ? scope : page;
  try {
    // Prefer stable Lever/Greenhouse EEOC name selectors when present.
    if (EEOC_MAPPED.has(mappedTo)) {
      const eeoName =
        mappedTo === "eeocgender"
          ? "eeo[gender]"
          : mappedTo === "eeocrace"
            ? "eeo[race]"
            : mappedTo === "eeocveteran"
              ? "eeo[veteran]"
              : mappedTo === "eeocdisability"
                ? "eeo[disability]"
                : "";
      if (eeoName) {
        const byName = root.locator(`select[name="${eeoName}"]`).first();
        if (await visible(byName)) {
          if (await selectNativeOption(byName, value, log)) return true;
        }
      }
    }

    if (spec.selector || spec.triggerSelector) {
      const loc = root.locator(spec.selector || spec.triggerSelector).first();
      if (await visible(loc)) {
        const tag = await loc.evaluate((el) => (el.tagName || "").toLowerCase()).catch(() => "");
        const sel = tag === "select" ? loc : loc.locator("select").first();
        if (await visible(sel)) {
          if (await selectNativeOption(sel, value, log)) return true;
        }
      }
    }
    const selects = root.locator("select");
    const count = await selects.count();
    for (let i = 0; i < count; i += 1) {
      const sel = selects.nth(i);
      if (!(await visible(sel))) continue;
      const blob = `${await sel.getAttribute("aria-label").catch(() => "")} ${await sel.getAttribute("name").catch(() => "")} ${await nearbyLabelText(sel)}`.toLowerCase();
      const matchesMapped = nameRe ? nameRe.test(blob) : false;
      const matchesLabel = labelRe ? labelRe.test(blob) : false;
      // When multiple selects exist, require a mapped/name or label hit — never pick the first blindly.
      if (count > 1 && !matchesMapped && !matchesLabel) continue;
      if (await selectNativeOption(sel, value, log)) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}
