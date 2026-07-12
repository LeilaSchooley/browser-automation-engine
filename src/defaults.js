/** Default engine settings — apps override via createEngine({ settings }). */
export const DEFAULT_SETTINGS = {
  browser_human_behavior: true,
  human_type_delay_min: 45,
  human_type_delay_max: 130,
  human_long_text_threshold: 80,
  smart_fill_passes: 3,
  ai_fill_enabled: false,
  agent_enabled: true,
  agent_max_steps: 24,
  /** Stop after this many consecutive no-progress steps (post-recovery). */
  agent_max_no_progress: 4,
  agent_ai: false,
  /** Semantic post-action validator (uses callLlm when available). */
  action_validator: true,
  /**
   * When true, agent may click Submit after the form is filled.
   * Job-apply products should leave this false (human reviews/submits).
   */
  auto_submit: false,
  objective_mode: true,
  cloudflare_wait_enabled: true,
  cloudflare_wait_timeout_sec: 120,
  site_mappings_path: "",
  site_learnings_path: "",
  site_accounts_path: "",
  auto_signup_enabled: true,
  account_email_base: "",
  listing_mode: true,
  browser_sessions_dir: "",
  email_verify_enabled: true,
  email_verify_timeout_ms: 25000,
  email_imap_host: "",
  email_imap_user: "",
  email_imap_pass: "",
  vision_fallback_enabled: false,
  vision_include_screenshot: true,
  stagehand_enabled: false,
  stagehand_model: "",
  stagehand_cache_enabled: true,
  captcha_solver_enabled: false,
  captcha_solver_url: "",
};
