/**
 * WaaS job-page “Reach out” modal — message (≥50 chars) + optional location-mismatch ack.
 *
 * Distinct from the profile wizard (/application/*). Stagehand must not mop this up
 * by re-clicking Apply; smart_fill owns this surface.
 */
import { humanPause, humanType } from "../human.js";
import { getSettings } from "../runtime.js";
import {
  looksLikeReachOutModal,
  LOCATION_MISMATCH_RE,
  OUTREACH_SEND_RE,
  MIN_OUTREACH_CHARS,
  MAX_OUTREACH_CHARS,
  truncateOutreachMessage,
} from "../patterns/outreach.js";

export { looksLikeReachOutModal, MAX_OUTREACH_CHARS, truncateOutreachMessage };

/**
 * @param {object} snap
 */
export function isWaasReachOutStep(snap) {
  return looksLikeReachOutModal(snap);
}

/**
 * Build a short personal outreach message (MIN…MAX chars).
 * Prefers stored cover letter; never invents a fake skill list.
 * Soft-truncates on word boundaries so the modal never cuts mid-word.
 * @param {object} context
 * @param {object} [opts]
 */
export function buildOutreachMessage(context = {}, opts = {}) {
  const min = opts.minChars || MIN_OUTREACH_CHARS;
  const max = opts.maxChars || MAX_OUTREACH_CHARS;
  const applicant = context.applicant || context.profile || {};
  const prefs = context.preferences || {};
  const job = context.job || {};
  const name =
    String(applicant.fullName || applicant.name || prefs.fullName || "").trim() || "there";
  const title = String(job.title || prefs.desiredTitle || prefs.desiredJobTitle || "the role").trim();
  const company = String(job.company || context.company || "your company").trim();

  const cover = String(context.coverLetter || opts.coverLetter || "").replace(/\s+/g, " ").trim();
  if (cover.length >= min) {
    return truncateOutreachMessage(cover, max);
  }

  let msg =
    `Hi, I'm ${name} and I'm interested in the ${title} role at ${company}. ` +
    `I'd love to learn more about the team and how I can contribute.`;
  if (msg.length < min) {
    msg += " Looking forward to connecting and sharing more about my background.";
  }
  return truncateOutreachMessage(msg, max);
}

/**
 * Check the conditional “open to relocating / location mismatch” box when present.
 * @param {import('playwright').Page} page
 * @param {object|null} log
 */
export async function checkLocationMismatchAck(page, log = null) {
  const result = await page
    .evaluate((reSource) => {
      const re = new RegExp(reSource, "i");
      const nodes = [
        ...document.querySelectorAll("label, [class*='checkbox'], [class*='Checkbox'], p, span, div"),
      ];
      for (const node of nodes) {
        const text = String(node.textContent || "").replace(/\s+/g, " ").trim();
        if (text.length < 20 || text.length > 400) continue;
        if (!re.test(text)) continue;
        const input =
          (node.matches?.("input[type='checkbox']") && node) ||
          node.querySelector?.("input[type='checkbox']") ||
          (node.getAttribute?.("for") && document.getElementById(node.getAttribute("for"))) ||
          null;
        if (!input || input.type !== "checkbox") continue;
        if (input.checked) return { ok: true, already: true };
        try {
          input.click();
          return { ok: true, already: false };
        } catch {
          return { ok: false };
        }
      }
      return { ok: false, missing: true };
    }, LOCATION_MISMATCH_RE.source)
    .catch(() => ({ ok: false }));

  if (result?.ok && !result.already) {
    log?.layer?.("waas_reach_out", "checked location-mismatch / open-to-relocate", "info");
    await humanPause(200, 350);
  } else if (result?.already) {
    log?.layer?.("waas_reach_out", "location-mismatch already checked", "debug");
  } else if (result?.missing) {
    log?.layer?.("waas_reach_out", "no location-mismatch checkbox (ok — conditional)", "debug");
  }
  return Boolean(result?.ok);
}

/**
 * Fill the primary outreach textarea with a message in [MIN, MAX] chars.
 * Honors textarea maxlength when present (WaaS = 580).
 * @param {import('playwright').Page} page
 * @param {string} message
 * @param {object|null} log
 */
export async function fillOutreachTextarea(page, message, log = null) {
  const loc = page.locator("textarea:visible").first();
  if ((await loc.count().catch(() => 0)) === 0) {
    log?.layer?.("waas_reach_out", "no visible textarea", "warn");
    return { ok: false, length: 0 };
  }

  const domMax = await loc
    .evaluate((el) => {
      const m = Number(el.getAttribute("maxlength") || el.maxLength || 0);
      return m > 0 && m < 100000 ? m : 0;
    })
    .catch(() => 0);
  const maxChars = domMax || MAX_OUTREACH_CHARS;

  let text = truncateOutreachMessage(message, maxChars);
  if (text.length < MIN_OUTREACH_CHARS) {
    text = truncateOutreachMessage(
      `${text} Looking forward to learning more about the role and team.`,
      maxChars,
    );
  }

  try {
    await loc.click({ timeout: 4000 });
    await loc.fill("");
    await humanType(loc, text, page);
  } catch {
    try {
      await loc.fill(text);
    } catch {
      return { ok: false, length: 0 };
    }
  }

  await humanPause(300, 500);
  const value = await loc.inputValue().catch(() => "");
  const len = String(value || "").trim().length;
  if (len < MIN_OUTREACH_CHARS) {
    const padded = truncateOutreachMessage(
      `${text} Looking forward to learning more about the role and team.`,
      maxChars,
    );
    await loc.fill(padded).catch(() => null);
    const again = await loc.inputValue().catch(() => "");
    const len2 = String(again || "").trim().length;
    log?.layer?.(
      "waas_reach_out",
      `filled message (${len2}/${maxChars} chars)${len2 < MIN_OUTREACH_CHARS ? " — still short" : ""}`,
      len2 >= MIN_OUTREACH_CHARS ? "info" : "warn",
    );
    return { ok: len2 >= MIN_OUTREACH_CHARS, length: len2, maxChars };
  }

  log?.layer?.("waas_reach_out", `filled message (${len}/${maxChars} chars)`, "info");
  return { ok: true, length: len, maxChars };
}

/**
 * Live DOM check — message committed and optional mismatch ack handled.
 * @param {import('playwright').Page} page
 */
export async function waasReachOutDomLooksComplete(page) {
  return page
    .evaluate((minChars) => {
      const ta = [...document.querySelectorAll("textarea")].find((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 40 && r.height > 20;
      });
      if (!ta) return false;
      const len = String(ta.value || "").trim().length;
      if (len < minChars) return false;

      // If mismatch copy is visible, its checkbox must be checked.
      const mismatchRe =
        /doesn.?t match your location|open to relocating|we.?ll update your profile/i;
      for (const node of document.querySelectorAll("label, p, span, div")) {
        const t = String(node.textContent || "").replace(/\s+/g, " ").trim();
        if (t.length < 20 || t.length > 400 || !mismatchRe.test(t)) continue;
        const input =
          node.querySelector?.("input[type='checkbox']") ||
          (node.getAttribute?.("for") && document.getElementById(node.getAttribute("for")));
        if (input && input.type === "checkbox" && !input.checked) return false;
      }
      return true;
    }, MIN_OUTREACH_CHARS)
    .catch(() => false);
}

/**
 * Fill Reach-out modal. Does not click Send unless auto_submit is true.
 * @param {import('playwright').Page} page
 * @param {object} snap
 * @param {object} context
 * @param {object|null} log
 */
export async function fillWaasReachOutMissing(page, snap, context, log = null) {
  if (!isWaasReachOutStep(snap) && !(await pageLooksLikeReachOut(page))) {
    return { ok: false, filled: [], alreadyComplete: false };
  }

  log?.layer?.("waas_reach_out", "detected Reach-out modal", "info");

  if (await waasReachOutDomLooksComplete(page)) {
    log?.layer?.("waas_reach_out", "already complete", "info");
    return { ok: true, filled: [], alreadyComplete: true };
  }

  const filled = [];
  await checkLocationMismatchAck(page, log);
  filled.push({
    type: "location_mismatch_ack",
    mappedTo: "willingtorelocate",
    source: "waas_reach_out",
  });

  const message = buildOutreachMessage(context);
  const msgResult = await fillOutreachTextarea(page, message, log);
  if (msgResult.ok) {
    filled.push({
      type: "outreach_message",
      mappedTo: "coverletter",
      source: "waas_reach_out",
      length: msgResult.length,
    });
  }

  const complete = await waasReachOutDomLooksComplete(page);
  const autoSubmit = getSettings().auto_submit === true;
  if (complete && autoSubmit) {
    const clicked = await clickOutreachSend(page, log);
    return {
      ok: complete,
      filled,
      alreadyComplete: false,
      sent: clicked,
      readyForSend: !clicked,
    };
  }

  if (complete) {
    log?.layer?.(
      "waas_reach_out",
      "ready — Send available (auto_submit off; left for manual review)",
      "info",
    );
  }

  return {
    ok: complete || msgResult.ok,
    filled,
    alreadyComplete: false,
    sent: false,
    readyForSend: complete,
  };
}

async function pageLooksLikeReachOut(page) {
  try {
    const url = page.url?.() || "";
    if (!/workatastartup\.com\/jobs\//i.test(url)) return false;
    const hasTa = (await page.locator("textarea:visible").count().catch(() => 0)) > 0;
    return hasTa;
  } catch {
    return false;
  }
}

async function clickOutreachSend(page, log) {
  const buttons = page.locator("button, [role='button'], input[type='submit']");
  const n = await buttons.count().catch(() => 0);
  for (let i = 0; i < Math.min(n, 12); i += 1) {
    const btn = buttons.nth(i);
    const text = String((await btn.innerText().catch(() => "")) || "").trim();
    if (!OUTREACH_SEND_RE.test(text)) continue;
    try {
      await btn.click({ timeout: 4000 });
      log?.layer?.("waas_reach_out", `clicked Send ("${text}")`, "info");
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}
