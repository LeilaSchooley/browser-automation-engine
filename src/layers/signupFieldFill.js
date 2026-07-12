/**
 * Discover and fill signup form fields from live DOM — no site-specific selectors.
 */
import { isUsernameFieldBlob } from "../patterns/auth.js";
import { ensurePasswordForSignup } from "../passwordPolicy.js";

/**
 * @typedef {{ kind: string, label: string, selector: string, type: string, order: number }} DiscoveredField
 */

/**
 * Scan visible inputs and classify by label/name/type/autocomplete.
 * @param {import('playwright').Page} page
 * @returns {Promise<DiscoveredField[]>}
 */
export async function discoverVisibleFormFields(page) {
  return page.evaluate(() => {
    function isVisible(el) {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
        return false;
      }
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    }

    function labelFor(el) {
      const parts = [
        el.labels?.[0]?.innerText,
        el.getAttribute("aria-label"),
        el.getAttribute("placeholder"),
        el.getAttribute("title"),
      ];
      return parts
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    }

    function buildSelector(el) {
      const id = el.id || "";
      if (id) {
        try {
          if (document.querySelectorAll(`#${CSS.escape(id)}`).length === 1) {
            return `#${CSS.escape(id)}`;
          }
        } catch {
          /* ignore */
        }
      }
      const name = el.name || "";
      if (name) return `[name="${name.replace(/"/g, '\\"')}"]`;
      return "";
    }

    function classify(el, label) {
      const type = (el.type || el.tagName || "").toLowerCase();
      const ac = (el.autocomplete || "").toLowerCase();
      const blob = `${el.name || ""} ${el.id || ""} ${el.placeholder || ""} ${ac} ${label}`.toLowerCase();

      if (["hidden", "submit", "button", "checkbox", "radio", "file", "search"].includes(type)) {
        return null;
      }

      if (type === "email" || /\bemail\b/.test(blob)) return "email";

      if (type === "password") {
        if (/confirm|repeat|again|verify|confirmation/.test(blob)) return "confirm_password";
        if (ac === "new-password") return "password";
        return "password";
      }

      if (ac === "username" || /\b(username|user[_-]?name|handle|nickname)\b/.test(blob)) {
        if (!/\bemail\b/.test(blob)) return "username";
      }

      if (ac === "name" || /\b(full.?name|your name|founder|company|organization|startup)\b/.test(blob)) {
        return "name";
      }

      if (/\b(first\s*name|given\s*name|forename|fname)\b/.test(blob) || ac === "given-name") {
        return "first_name";
      }
      if (/\b(last\s*name|surname|family\s*name|lname)\b/.test(blob) || ac === "family-name") {
        return "last_name";
      }

      if (type === "text" || type === "tel") {
        if (/\b(name|company|organization)\b/.test(blob)) return "name";
        return "text";
      }

      return "unknown";
    }

    const fields = [];
    const inputs = document.querySelectorAll("input, textarea, select");
    for (const el of inputs) {
      if (!isVisible(el)) continue;
      const label = labelFor(el);
      const kind = classify(el, label);
      if (!kind) continue;
      const selector = buildSelector(el);
      if (!selector) continue;
      fields.push({
        kind,
        label: label.slice(0, 80),
        selector,
        type: el.type || el.tagName.toLowerCase(),
        order: fields.length,
      });
    }
    return fields;
  });
}

/**
 * Fill every visible signup field discovered from the DOM.
 * @param {import('playwright').Page} page
 * @param {{ email?: string, username?: string, password?: string, fullName?: string, firstName?: string, lastName?: string }} values
 * @param {{ log?: { layer: Function } }} [opts]
 */
export async function fillSignupFormFromDom(page, values, opts = {}) {
  const { log } = opts;
  const fields = await discoverVisibleFormFields(page);
  const result = {
    fields,
    filled: /** @type {Record<string, boolean>} */ ({}),
    selectorsByKind: /** @type {Record<string, string>} */ ({}),
    missing: /** @type {string[]} */ ([]),
  };

  const emailFields = fields.filter((f) => f.kind === "email");
  const passwordFields = fields.filter((f) => f.kind === "password");
  const confirmFields = fields.filter((f) => f.kind === "confirm_password");
  const usernameFields = fields.filter((f) => f.kind === "username");
  const nameFields = fields.filter((f) => f.kind === "name");
  const firstNameFields = fields.filter((f) => f.kind === "first_name");
  const lastNameFields = fields.filter((f) => f.kind === "last_name");

  async function fillField(field, value, label) {
    if (!value || !field.selector) return false;
    try {
      const loc = page.locator(field.selector).first();
      if (!(await loc.isVisible({ timeout: 700 }).catch(() => false))) return false;
      await loc.click({ timeout: 3000 }).catch(() => {});
      await loc.fill(value, { timeout: 5000 });
      result.filled[field.kind] = true;
      result.selectorsByKind[field.kind] = field.selector;
      log?.layer("signup", `filled ${label} (${field.label || field.selector})`, "debug");
      return true;
    } catch {
      return false;
    }
  }

  for (const field of firstNameFields) {
    await fillField(field, values.firstName || values.fullName?.split(/\s+/)[0] || "", "first_name");
  }
  for (const field of lastNameFields) {
    await fillField(
      field,
      values.lastName || values.fullName?.split(/\s+/).slice(1).join(" ") || "",
      "last_name",
    );
  }
  for (const field of nameFields) {
    await fillField(field, values.fullName, "name");
  }

  for (const field of usernameFields) {
    await fillField(field, values.username || values.email?.split("@")[0] || "", "username");
  }

  for (const field of emailFields) {
    await fillField(field, values.email, "email");
  }

  for (let i = 0; i < passwordFields.length; i++) {
    await fillField(passwordFields[i], values.password, i === 0 ? "password" : `password[${i}]`);
  }

  for (const field of confirmFields) {
    await fillField(field, values.password, "confirm_password");
  }

  // Some sites use two password fields without confirm labels — fill remaining empties
  if (passwordFields.length >= 2 && !result.filled.confirm_password) {
    for (let i = 1; i < passwordFields.length; i++) {
      await fillField(passwordFields[i], values.password, `password[${i}]`);
    }
  }

  if (emailFields.length && !result.filled.email) result.missing.push("email");
  if (usernameFields.length && !result.filled.username) result.missing.push("username");
  if (passwordFields.length && !result.filled.password) result.missing.push("password");
  if (nameFields.length && !result.filled.name) result.missing.push("name");
  if (firstNameFields.length && !result.filled.first_name) result.missing.push("first_name");
  if (lastNameFields.length && !result.filled.last_name) result.missing.push("last_name");

  const hasIdentity = Boolean(result.filled.email || result.filled.username);
  const hasPassword = Boolean(result.filled.password);

  if (hasPassword && values.password) {
    const ensured = await ensurePasswordForSignup(page, values.password, { log });
    if (ensured.password && ensured.password !== values.password) {
      result.filled.password = true;
      log?.layer("signup", "password adjusted to satisfy site policy", "info");
    }
    result.password = ensured.password;
    result.passwordPolicyOk = ensured.ok;
  }

  return {
    ...result,
    complete: hasIdentity && hasPassword && result.missing.length === 0,
  };
}

/** Node-side helper for tests — mirrors browser classify heuristics. */
export function classifyFieldBlob(blob) {
  const b = String(blob || "").toLowerCase();
  if (/\bemail\b/.test(b)) return "email";
  if (/confirm|repeat|again|verify|confirmation/.test(b)) return "confirm_password";
  if (/\bpassword\b/.test(b)) return "password";
  if (isUsernameFieldBlob(b)) return "username";
  if (/\b(name|full.?name|founder|company)\b/.test(b)) return "name";
  return "unknown";
}
