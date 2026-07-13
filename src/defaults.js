/** Default engine settings — apps override via createEngine({ settings }). */
export const DEFAULT_SETTINGS = {
  browser_human_behavior: true,
  human_type_delay_min: 45,
  human_type_delay_max: 130,
  /** Multiplier for pauses between clicks/steps and per-char typing (1 = default). */
  human_timing_scale: 1.25,
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
  email_verify_manual_timeout_ms: 600000,
  email_imap_host: "",
  email_imap_user: "",
  email_imap_pass: "",
  email_imap_port: 993,
  vision_fallback_enabled: false,
  vision_include_screenshot: true,
  layout_context_enabled: true,
  early_vision_escalation: true,
  /**
   * Action brain routing:
   * - primary: LLM+affordance map decides every non-safety step (default when agent_ai)
   * - escalate: legacy heuristic-first, AI only when stuck/ambiguous
   * - off: heuristics only
   */
  action_brain_mode: "",
  /** When true, try deterministic policy before LLM in primary mode. */
  deterministic_first: true,
  /** When true, action catalog ranks next moves before step-type deterministic policy. */
  action_catalog_first: true,
  /** CDP accessibility-tree perception with stable refs and page diff. */
  page_perception_enabled: false,
  /** Directory for JSONL event logs and debug screenshots. */
  event_log_dir: "",
  debug_screenshots_enabled: false,
  stagehand_enabled: false,
  stagehand_model: "",
  stagehand_cache_enabled: true,
  captcha_solver_enabled: false,
  captcha_solver_url: "",
};
