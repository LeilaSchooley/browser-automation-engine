/** Shared account/onboarding policy for profiles that can create site accounts. */
export const ACCOUNT_WORKFLOW_SETTINGS = Object.freeze({
  auto_signup_enabled: true,
  account_email_base: "",
  account_email_alias_enabled: false,
  email_verify_enabled: true,
  email_verify_timeout_ms: 25000,
  email_verify_manual_timeout_ms: 600000,
  email_imap_host: "",
  email_imap_user: "",
  email_imap_pass: "",
  email_imap_port: 993,
});
