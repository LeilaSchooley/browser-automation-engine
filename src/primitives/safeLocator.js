/**
 * Safe Playwright name/text matchers.
 * Prevents short CTAs like "Continue" from hitting "Continue with Apple".
 */

export function escapeRegExp(value = "") {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Decorative glyphs sites append to CTAs (chevrons/arrows) that are absent from the a11y name. */
const DECORATIVE_GLYPH_RE = /[›»▸▹❯⟩→➜➔➙➛➝➞⟶⟼»↳↦▶►◦·|]/g;

/** Strip decorative chevrons/arrows and collapse whitespace ("Apply to role ›" → "Apply to role"). */
export function stripDecorativeGlyphs(text = "") {
  return String(text || "")
    .replace(DECORATIVE_GLYPH_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Single-token / short action labels that must never substring-match longer SSO CTAs. */
export const SHORT_CTA_RE =
  /^(continue|next|proceed|sign in|log in|sign up|submit|apply|ok|yes|no|not yet|save|done|confirm|close|skip|register|join|login)$/i;

export function wordCount(text = "") {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

/**
 * Prefer exact/anchored matching for short CTAs (≤4 words, no sentence punctuation).
 */
export function shouldExactMatchName(text = "") {
  const t = String(text || "").trim();
  if (!t) return false;
  if (SHORT_CTA_RE.test(t)) return true;
  if (wordCount(t) <= 4 && !/[.?!]/.test(t) && t.length <= 40) return true;
  return false;
}

/**
 * Build a role/name RegExp from discovered candidate text.
 * @returns {RegExp|null}
 */
export function roleNameMatcher(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const stripped = stripDecorativeGlyphs(raw);
  const base = stripped || raw;
  const escaped = escapeRegExp(base).slice(0, 80);
  if (!escaped) return null;
  // Decorative glyph removed (e.g. "Apply to role ›"): anchor at start only so the matcher
  // tolerates either accessible name ("Apply to role" or "Apply to role ›").
  if (stripped && stripped !== raw && shouldExactMatchName(base)) {
    return new RegExp(`^${escaped}\\b`, "i");
  }
  if (shouldExactMatchName(base)) return new RegExp(`^${escaped}$`, "i");
  return new RegExp(escaped, "i");
}

/**
 * Normalize string or RegExp role names so short unanchored CTAs become exact.
 * @param {string|RegExp|null|undefined} name
 * @returns {RegExp|null}
 */
export function normalizeRoleName(name) {
  if (name == null || name === "") return null;
  if (typeof name === "string") return roleNameMatcher(name);
  if (!(name instanceof RegExp)) return null;

  const src = name.source;
  if (src.startsWith("^") && src.endsWith("$")) return name;

  // Bare short token: /continue/i → /^continue$/i
  const bare = src.replace(/\\/g, "");
  if (SHORT_CTA_RE.test(bare) || (wordCount(bare) <= 4 && !/[.?|()+*]/.test(bare) && bare.length <= 40)) {
    const flags = name.flags.includes("i") ? name.flags : `${name.flags}i`;
    return new RegExp(`^${src}$`, flags);
  }
  return name;
}

/**
 * @param {import('playwright').Page|import('playwright').Locator} root
 * @param {string} role
 * @param {string|RegExp} name
 * @param {object} [options]
 */
export function safeRoleLocator(root, role, name, options = {}) {
  const safeName = normalizeRoleName(name);
  if (!safeName) {
    // Empty match — never click a random control.
    return root.getByRole(role, { ...options, name: /^__never_match_empty_cta__$/ });
  }
  return root.getByRole(role, { ...options, name: safeName });
}

/**
 * @param {import('playwright').Page|import('playwright').Locator} root
 * @param {string|RegExp} text
 * @param {object} [options]
 */
export function safeTextLocator(root, text, options = {}) {
  const safeName = normalizeRoleName(text);
  if (!safeName) {
    return root.getByText(/^__never_match_empty_cta__$/, options);
  }
  return root.getByText(safeName, options);
}

/**
 * Labels: exact for short strings so "Email" does not match "Email address from Apple".
 * @param {import('playwright').Page|import('playwright').Locator} root
 * @param {string} text
 * @param {object} [options]
 */
export function safeLabelLocator(root, text, options = {}) {
  const t = String(text || "").trim();
  if (!t) return root.getByLabel(/^__never_match_empty_cta__$/);
  if (shouldExactMatchName(t)) {
    return root.getByLabel(t, { ...options, exact: true });
  }
  return root.getByLabel(t, { ...options, exact: false });
}
