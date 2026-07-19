import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getSettings } from "./runtime.js";
import { normalizeHost } from "./host.js";
import { generatePassword, generatePasswordWithPolicy } from "./passwordPolicy.js";

export { generatePassword, generatePasswordWithPolicy };

function accountsPath() {
  return getSettings().site_accounts_path || "";
}

export function loadSiteAccounts() {
  const filePath = accountsPath();
  if (!filePath || !fs.existsSync(filePath)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return data?.hosts && typeof data.hosts === "object" ? data.hosts : data;
  } catch {
    return {};
  }
}

export function loadAccountForHost(hostname) {
  const key = normalizeHost(hostname);
  if (!key) return null;
  const account = loadSiteAccounts()[key];
  if (!account?.password) return null;
  if (!account.email && !account.username) return null;
  return account;
}

export function saveAccountForHost(hostname, account) {
  const filePath = accountsPath();
  const key = normalizeHost(hostname);
  if (!filePath || !key || !account?.password) return null;
  if (!account.email && !account.username) return null;

  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  let store = { hosts: {} };
  if (fs.existsSync(filePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      store = raw?.hosts ? raw : { hosts: raw };
    } catch {
      store = { hosts: {} };
    }
  }

  const prev = store.hosts[key] || {};
  store.hosts[key] = {
    ...prev,
    ...account,
    hostname: key,
    updatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(filePath, JSON.stringify(store, null, 2));
  return store.hosts[key];
}

export function slugUsername(label = "", { maxLen = 15 } = {}) {
  const base = String(label || "user")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, Math.max(4, maxLen - 4));
  const suffix = crypto.randomBytes(2).toString("hex");
  const combined = `${base || "qluser"}${suffix}`.slice(0, maxLen);
  return combined;
}

export function emailBaseFromContext(context) {
  const settings = getSettings();
  const auth = context?.auth || {};
  const profile = context?.profile || context?.applicant || {};
  return (
    auth.provisionBaseEmail ||
    auth.email ||
    profile.email ||
    settings.account_email_base ||
    process.env.SUBMISSION_ACCOUNT_EMAIL ||
    ""
  );
}

export function canProvisionAccounts(context) {
  if (getSettings().auto_signup_enabled === false) return false;
  // Username-only sites can provision without email if profile name exists
  const base = emailBaseFromContext(context);
  if (base && base.includes("@")) return true;
  const applicantEmail = context?.applicant?.email || context?.profile?.email;
  if (applicantEmail && String(applicantEmail).includes("@")) return true;
  return Boolean(context?.profile?.startupName || context?.profile?.founderName || context?.applicant?.fullName);
}

/**
 * Generate credentials for a directory host. Exact email is the safe default; plus-addressing
 * is opt-in because some providers and job sites reject aliases.
 */
export function generateAccountCredentials({ emailBase, hostname, label = "", useEmailAlias } = {}) {
  const password = generatePasswordWithPolicy();
  if (!emailBase || !emailBase.includes("@")) {
    const username = slugUsername(label || hostname, { maxLen: 15 });
    return { username, password, email: "", usernameUsed: true };
  }
  const aliasEnabled =
    useEmailAlias === undefined
      ? getSettings().account_email_alias_enabled === true
      : useEmailAlias === true;
  if (!aliasEnabled) {
    return { email: String(emailBase).trim().toLowerCase(), username: "", password, usernameUsed: false };
  }
  const [local, domain] = emailBase.split("@");
  const hostSlug = normalizeHost(hostname).replace(/\./g, "-").slice(0, 24) || "site";
  const tag = (label || crypto.randomBytes(3).toString("hex")).replace(/[^a-z0-9-]/gi, "").slice(0, 12);
  const email = `${local}+ql-${hostSlug}-${tag}@${domain}`.toLowerCase();
  // Email-based signups — don't invent a username unless the form actually asks for one.
  return { email, username: "", password, usernameUsed: false };
}

export function resolveAccountForHost(context, hostname, { provision = true } = {}) {
  const stored = loadAccountForHost(hostname);
  if (stored) {
    return { ...stored, isNew: false, source: "store" };
  }
  if (!provision || !canProvisionAccounts(context)) return null;

  const emailBase = emailBaseFromContext(context);
  const creds = generateAccountCredentials({
    emailBase,
    hostname,
    label: context?.profile?.startupName || context?.sessionId || "",
    useEmailAlias: getSettings().account_email_alias_enabled === true,
  });

  const saved = saveAccountForHost(hostname, {
    ...creds,
    pending: true,
    startupName: context?.profile?.startupName || null,
    createdAt: new Date().toISOString(),
  });

  return { ...(saved || creds), isNew: true, source: "provisioned" };
}

export function markAccountVerified(hostname) {
  const existing = loadAccountForHost(hostname);
  if (!existing) return null;
  return saveAccountForHost(hostname, { ...existing, pending: false, verified: true });
}

/** Site reported the account already exists — prefer sign-in next. */
export function markAccountExists(hostname) {
  const existing = loadAccountForHost(hostname);
  if (!existing) return null;
  return saveAccountForHost(hostname, {
    ...existing,
    pending: false,
    verified: true,
    existsOnSite: true,
    lastExistingAccountAt: new Date().toISOString(),
  });
}

/** Login rejected — keep credentials but allow signup retry on next step. */
export function markAccountLoginFailed(hostname) {
  const existing = loadAccountForHost(hostname);
  if (!existing) return null;
  return saveAccountForHost(hostname, {
    ...existing,
    pending: true,
    verified: false,
    lastLoginFailedAt: new Date().toISOString(),
  });
}

export function attachAccountToContext(context, account) {
  if (!context || !account) return context;
  context.auth = {
    ...(context.auth || {}),
    email: account.email || context.auth?.email,
    username: account.username || context.auth?.username,
    password: account.password,
    totpSecret: account.totpSecret || account.totp_secret || context.auth?.totpSecret || "",
    provisioned: account.isNew || account.pending,
  };
  context.siteAccount = account;
  return context;
}
