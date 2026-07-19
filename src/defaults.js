import { CORE_DEFAULT_SETTINGS } from "./core/defaults.js";

/**
 * Compatibility policy for callers that do not choose a profile.
 * New consumers should prefer createApplyEngine/createDirectoryEngine or pass
 * an explicit profile to createEngine().
 */
export const LEGACY_PROFILE_SETTINGS = Object.freeze({
  auto_submit: false,
  review_mode: true,
  auto_signup_enabled: true,
  account_email_base: "",
  account_email_alias_enabled: false,
  listing_mode: true,
  email_verify_enabled: true,
  email_verify_timeout_ms: 25000,
  email_verify_manual_timeout_ms: 600000,
  otp_verify_enabled: true,
  otp_verify_timeout_ms: 25000,
  otp_verify_manual_timeout_ms: 600000,
  email_imap_host: "",
  email_imap_user: "",
  email_imap_pass: "",
  email_imap_port: 993,
  stagehand_cache_dir: "",
  totp_enabled: false,
  cua_vision_enabled: false,
  captcha_solver_enabled: false,
  captcha_solver_api_key: "",
});

/** Default engine settings — retained for backward compatibility. */
export const DEFAULT_SETTINGS = Object.freeze({
  ...CORE_DEFAULT_SETTINGS,
  ...LEGACY_PROFILE_SETTINGS,
});

export { CORE_DEFAULT_SETTINGS };
