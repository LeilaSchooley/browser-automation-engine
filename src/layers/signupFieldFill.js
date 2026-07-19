/**
 * Discover and fill signup form fields from live DOM — no site-specific selectors.
 * Uses deep scan (open shadow + same-origin iframes).
 */
import { isUsernameFieldBlob } from "../patterns/auth.js";
import { ensurePasswordForSignup } from "../passwordPolicy.js";
import { collectVisibleFormControls, fillStampedControl } from "./domDeepScan.js";

/**
 * @typedef {{
 *   kind: string,
 *   label: string,
 *   selector: string,
 *   qlId: string,
 *   nth: number,
 *   type: string,
 *   order: number,
 *   autocomplete: string,
 * }} DiscoveredField
 */

function classifyControl(el) {
  const type = String(el.type || el.tag || "").toLowerCase();
  const ac = String(el.autocomplete || "").toLowerCase();
  const attrBlob = `${el.name || ""} ${el.id || ""} ${el.placeholder || ""} ${ac}`.toLowerCase();
  const blob = `${attrBlob} ${el.label || ""}`.toLowerCase();

  if (["hidden", "submit", "button", "checkbox", "radio", "file", "search"].includes(type)) {
    return null;
  }

  if (type === "password") {
    if (/confirm|repeat|again|verify|confirmation/.test(blob)) return "confirm_password";
    return "password";
  }
  if (type === "email" || ac === "email") return "email";
  if (/\bemail\b/.test(attrBlob) || (/\bemail\b/.test(blob) && !/\bpassword\b/.test(attrBlob))) {
    return "email";
  }
  if (ac === "username" || /\b(username|user[_-]?name|handle|nickname)\b/.test(blob)) {
    if (!/\bemail\b/.test(attrBlob)) return "username";
  }
  if (/\b(first\s*name|given\s*name|forename|fname)\b/.test(blob) || ac === "given-name") {
    return "first_name";
  }
  if (/\b(last\s*name|surname|family\s*name|lname)\b/.test(blob) || ac === "family-name") {
    return "last_name";
  }
  if (ac === "name" || /\b(full.?name|your name)\b/.test(blob)) return "name";
  if (type === "text" || type === "tel" || type === "textarea" || type === "") {
    if (/\b(company|organization|startup)\b/.test(blob)) return "name";
    return "text";
  }
  return "unknown";
}

/** YC-style: unlabeled text,text,email,text,password → first/last/email/username/password */
function refineKinds(fields) {
  const emailIdx = fields.findIndex((f) => f.kind === "email");
  const passwordIdx = fields.findIndex((f) => f.kind === "password");
  if (passwordIdx < 0) return fields;

  if (emailIdx >= 2) {
    if (fields[0].kind === "text" || fields[0].kind === "unknown") fields[0].kind = "first_name";
    if (fields[1].kind === "text" || fields[1].kind === "unknown") fields[1].kind = "last_name";
  } else if (emailIdx < 0 && fields.length >= 4) {
    if (passwordIdx === fields.length - 1) {
      if (fields[0].kind === "text" || fields[0].kind === "unknown") fields[0].kind = "first_name";
      if (fields[1].kind === "text" || fields[1].kind === "unknown") fields[1].kind = "last_name";
      if (fields[2].kind === "text" || fields[2].kind === "unknown") fields[2].kind = "email";
    }
  }

  if (emailIdx >= 0 && passwordIdx > emailIdx + 1) {
    for (let i = emailIdx + 1; i < passwordIdx; i++) {
      if (fields[i].kind === "text" || fields[i].kind === "unknown") fields[i].kind = "username";
    }
  }
  return fields;
}

function buildSelectorHint(el) {
  if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) return `#${el.id}`;
  if (el.name) return `[name="${String(el.name).replace(/"/g, '\\"')}"]`;
  return "";
}

/**
 * Scan visible inputs (incl. open shadow + same-origin iframes) and classify.
 * @param {import('playwright').Page} page
 * @returns {Promise<DiscoveredField[]>}
 */
export async function discoverVisibleFormFields(page) {
  const controls = await collectVisibleFormControls(page);
  const fields = [];
  let nth = 0;
  for (const el of controls) {
    const kind = classifyControl(el);
    if (!kind) {
      nth += 1;
      continue;
    }
    fields.push({
      kind,
      label: el.label || "",
      selector: buildSelectorHint(el),
      qlId: el.qlId,
      nth,
      type: el.type,
      order: fields.length,
      autocomplete: el.autocomplete || "",
    });
    nth += 1;
  }
  return refineKinds(fields);
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

  const byKind = (kind) => fields.filter((f) => f.kind === kind);

  async function fillField(field, value, label) {
    if (!value || !field?.qlId) return false;
    try {
      let ok = await fillStampedControl(page, field.qlId, value);
      if (!ok && field.selector) {
        const loc = page.locator(field.selector).first();
        if (await loc.isVisible({ timeout: 500 }).catch(() => false)) {
          await loc.click({ timeout: 3000 }).catch(() => {});
          await loc.fill(value, { timeout: 5000 });
          ok = true;
        }
      }
      if (!ok) return false;
      result.filled[field.kind] = true;
      if (field.selector) result.selectorsByKind[field.kind] = field.selector;
      log?.layer("signup", `filled ${label} (${field.label || field.qlId})`, "info");
      return true;
    } catch {
      return false;
    }
  }

  for (const field of byKind("first_name")) {
    await fillField(field, values.firstName || values.fullName?.split(/\s+/)[0] || "", "first_name");
  }
  for (const field of byKind("last_name")) {
    await fillField(
      field,
      values.lastName || values.fullName?.split(/\s+/).slice(1).join(" ") || "",
      "last_name",
    );
  }
  for (const field of byKind("name")) {
    await fillField(field, values.fullName, "name");
  }
  for (const field of byKind("username")) {
    await fillField(field, values.username || values.email?.split("@")[0] || "", "username");
  }
  for (const field of byKind("email")) {
    await fillField(field, values.email, "email");
  }
  const passwordFields = byKind("password");
  for (let i = 0; i < passwordFields.length; i++) {
    await fillField(passwordFields[i], values.password, i === 0 ? "password" : `password[${i}]`);
  }
  for (const field of byKind("confirm_password")) {
    await fillField(field, values.password, "confirm_password");
  }
  if (passwordFields.length >= 2 && !result.filled.confirm_password) {
    for (let i = 1; i < passwordFields.length; i++) {
      await fillField(passwordFields[i], values.password, `password[${i}]`);
    }
  }

  for (const kind of ["email", "username", "password", "name", "first_name", "last_name"]) {
    if (byKind(kind).length && !result.filled[kind]) result.missing.push(kind);
  }

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

  log?.layer("signup", `discovered ${fields.length} fields: ${fields.map((f) => f.kind).join(", ")}`, "info");

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
  if (/\b(first\s*name|given\s*name)\b/.test(b)) return "first_name";
  if (/\b(last\s*name|surname|family)\b/.test(b)) return "last_name";
  if (/\b(name|full.?name|founder|company)\b/.test(b)) return "name";
  return "unknown";
}
