/** Default engine settings — apps override via createEngine({ settings }). */
export const DEFAULT_SETTINGS = {
  browser_human_behavior: true,
  human_type_delay_min: 45,
  human_type_delay_max: 130,
  human_long_text_threshold: 80,
  smart_fill_passes: 3,
  ai_fill_enabled: false,
  agent_enabled: true,
  agent_max_steps: 12,
  agent_ai: false,
  cloudflare_wait_enabled: true,
  cloudflare_wait_timeout_sec: 120,
  site_mappings_path: "",
};
