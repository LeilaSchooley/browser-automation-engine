/**
 * Password policy — parse visible rules, generate compliant passwords, recover on failure.
 * Site-agnostic; reads checklist text / page copy, never hardcodes hosts.
 */
import crypto from "crypto";

export const DEFAULT_PASSWORD_RULES = {
  lowercase: true,
  uppercase: true,
  digit: true,
  special: true,
  minLength: 8,
};

const LOWER = "abcdefghijkmnopqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";
const SPECIAL = "!@#$%";
const ALL_CHARS = LOWER + UPPER + DIGITS + SPECIAL;

/** @param {string} text */
export function parsePasswordRequirementsFromText(text) {
  const blob = String(text || "");
  if (!blob.trim()) return { ...DEFAULT_PASSWORD_RULES };

  const mentionsPolicy =
    /one\s+lowercase|one\s+uppercase|one\s+number|one\s+special|minimum\s+of\s+\d+\s+character|at\s+least\s+\d+\s+character|both numbers and letters|numbers and letters/i.test(
      blob,
    );
  if (!mentionsPolicy) return { ...DEFAULT_PASSWORD_RULES };

  if (/both numbers and letters|numbers and letters/i.test(blob)) {
    const minMatch = blob.match(/(\d+)\s+minimum|minimum\s+(?:of\s+)?(\d+)|at\s+least\s+(\d+)/i);
    const minLength = parseInt(minMatch?.[1] || minMatch?.[2] || minMatch?.[3] || "8", 10) || 8;
    return {
      lowercase: true,
      uppercase: false,
      digit: true,
      special: false,
      minLength,
    };
  }

  const rules = {
    lowercase: /one\s+lowercase|lowercase\s+character/i.test(blob),
    uppercase: /one\s+uppercase|uppercase\s+character/i.test(blob),
    digit: /one\s+number|at\s+least\s+one\s+digit|\bone\s+digit\b/i.test(blob),
    special: /one\s+special|special\s+character/i.test(blob),
    minLength: 8,
  };

  const minMatch = blob.match(/minimum\s+of\s+(\d+)|at\s+least\s+(\d+)\s+character/i);
  if (minMatch) {
    rules.minLength = parseInt(minMatch[1] || minMatch[2] || "8", 10) || 8;
  }

  if (!rules.lowercase && !rules.uppercase && !rules.digit && !rules.special) {
    return { ...DEFAULT_PASSWORD_RULES, minLength: rules.minLength };
  }

  return rules;
}

/** @param {string} password @param {typeof DEFAULT_PASSWORD_RULES} rules */
export function passwordMeetsRules(password, rules = DEFAULT_PASSWORD_RULES) {
  const pwd = String(password || "");
  const minLen = rules.minLength || 8;
  if (pwd.length < minLen) return false;
  if (rules.lowercase && !/[a-z]/.test(pwd)) return false;
  if (rules.uppercase && !/[A-Z]/.test(pwd)) return false;
  if (rules.digit && !/\d/.test(pwd)) return false;
  if (rules.special && !/[^a-zA-Z0-9]/.test(pwd)) return false;
  return true;
}

/** @param {typeof DEFAULT_PASSWORD_RULES} [rules] @param {number} [length] */
export function generatePasswordWithPolicy(rules = DEFAULT_PASSWORD_RULES, length = 18) {
  const minLen = Math.max(rules.minLength || 8, length);
  const parts = [];
  if (rules.lowercase !== false) parts.push(LOWER[crypto.randomInt(LOWER.length)]);
  if (rules.uppercase !== false) parts.push(UPPER[crypto.randomInt(UPPER.length)]);
  if (rules.digit !== false) parts.push(DIGITS[crypto.randomInt(DIGITS.length)]);
  if (rules.special !== false) parts.push(SPECIAL[crypto.randomInt(SPECIAL.length)]);

  while (parts.length < minLen) {
    parts.push(ALL_CHARS[crypto.randomInt(ALL_CHARS.length)]);
  }

  for (let i = parts.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [parts[i], parts[j]] = [parts[j], parts[i]];
  }

  let out = parts.join("");
  if (!passwordMeetsRules(out, rules)) {
    out = generatePasswordWithPolicy(rules, minLen + 2);
  }
  return out;
}

/** Backward-compatible alias — always satisfies default policy. */
export function generatePassword(length = 18) {
  return generatePasswordWithPolicy(DEFAULT_PASSWORD_RULES, length);
}

/**
 * Read live checklist rows near password inputs (unchecked = failing).
 * @param {import('playwright').Page} page
 * @returns {Promise<string[]>} failing rule keys: lowercase|uppercase|digit|special|minLength
 */
export async function readLivePasswordFailures(page) {
  return page.evaluate(() => {
    const fails = [];
    const ruleForText = (t) => {
      if (/one\s+lowercase|lowercase\s+character/i.test(t)) return "lowercase";
      if (/one\s+uppercase|uppercase\s+character/i.test(t)) return "uppercase";
      if (/one\s+number|one\s+digit/i.test(t)) return "digit";
      if (/one\s+special|special\s+character/i.test(t)) return "special";
      if (/minimum\s+of\s+\d+|at\s+least\s+\d+\s+character/i.test(t)) return "minLength";
      return null;
    };

    const rows = document.querySelectorAll("li, div, span, p");
    for (const el of rows) {
      const raw = (el.innerText || "").replace(/\s+/g, " ").trim();
      if (!raw || raw.length > 80) continue;
      const key = ruleForText(raw);
      if (!key) continue;

      const row = el.closest("li") || el.parentElement || el;
      const blob = `${row.className || ""} ${row.innerHTML || ""}`.toLowerCase();
      const hasCheck =
        row.querySelector(
          '[class*="check"], [class*="success"], [class*="valid"], [data-status="success"], [aria-checked="true"]',
        ) != null;
      const hasFail =
        /diamond|pending|invalid|error|fail|unchecked/.test(blob) ||
        row.querySelector('[class*="error"], [class*="invalid"], [data-status="error"]') != null;

      if (hasFail || (!hasCheck && !/check|success|valid|complete/.test(blob))) {
        if (!fails.includes(key)) fails.push(key);
      }
    }
    return fails;
  });
}

/**
 * @param {import('playwright').Page} page
 * @returns {Promise<typeof DEFAULT_PASSWORD_RULES>}
 */
export async function readPasswordPolicyFromPage(page) {
  const text = await page.evaluate(() => (document.body?.innerText || "").slice(0, 4000));
  return parsePasswordRequirementsFromText(text);
}

async function refillPasswordInputs(page, password) {
  const fields = page.locator('input[type="password"]');
  const count = await fields.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const loc = fields.nth(i);
    if (!(await loc.isVisible().catch(() => false))) continue;
    await loc.click({ timeout: 2000 }).catch(() => {});
    await loc.fill(password, { timeout: 5000 });
    await loc.dispatchEvent("input").catch(() => {});
    await loc.dispatchEvent("change").catch(() => {});
    await loc.dispatchEvent("blur").catch(() => {});
  }
}

/**
 * Ensure password satisfies visible policy; refill fields and retry live checklist.
 * @param {import('playwright').Page} page
 * @param {string} password
 * @param {{ log?: { layer: Function }, maxRounds?: number }} [opts]
 */
export async function ensurePasswordForSignup(page, password, opts = {}) {
  const { log, maxRounds = 3 } = opts;
  const policy = await readPasswordPolicyFromPage(page);
  let pwd = passwordMeetsRules(password, policy) ? password : generatePasswordWithPolicy(policy);

  for (let round = 0; round < maxRounds; round += 1) {
    await refillPasswordInputs(page, pwd);
    await page.waitForTimeout(400);

    const liveFails = await readLivePasswordFailures(page);
    if (!liveFails.length && passwordMeetsRules(pwd, policy)) {
      return { password: pwd, ok: true, policy, retried: pwd !== password };
    }

    const strict = { ...policy };
    for (const key of liveFails) {
      if (key === "minLength") strict.minLength = Math.max(strict.minLength || 8, 8);
      else strict[key] = true;
    }

    if (!passwordMeetsRules(pwd, strict)) {
      pwd = generatePasswordWithPolicy(strict);
      log?.layer("signup", `password policy retry round ${round + 1} (${liveFails.join(", ") || "rules"})`, "info");
      continue;
    }

    if (liveFails.length) {
      pwd = generatePasswordWithPolicy(strict);
      log?.layer("signup", `live checklist failing: ${liveFails.join(", ")} — regenerating`, "info");
      continue;
    }
  }

  const ok = passwordMeetsRules(pwd, policy);
  return { password: pwd, ok, policy, retried: pwd !== password };
}

/** True when page shows password + policy checklist. */
export function hasPasswordPolicyGate(snap) {
  if ((snap?.passwordFieldCount || 0) === 0) return false;
  const blob = `${snap.pageText || ""} ${snap.applyModalTitle || ""}`.toLowerCase();
  return /one\s+lowercase|one\s+uppercase|one\s+number|one\s+special|minimum\s+of\s+\d+\s+character/i.test(
    blob,
  );
}
