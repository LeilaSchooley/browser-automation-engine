/**
 * AI layer contracts — Zod schemas + LLM JSON parsing.
 * Self-contained so the core engine runs without @job-apply-ai/shared.
 * When that package is installed (job-apply-ai monorepo), schemas stay compatible.
 */
import { z } from "zod";

export const RECOVERY_ACTIONS = [
  "dismiss_overlay",
  "upload_resume",
  "click_modal",
  "click_apply",
  "click_continue",
  "accept_cookies",
  "smart_fill",
  "wait_load",
  "manual",
  "done",
  "wait_user",
  "ai_replan",
];

export const ValidatorResponseSchema = z.object({
  progressed: z.boolean(),
  reason: z.string().max(240).optional().default("validator"),
  recovery: z.enum(RECOVERY_ACTIONS).nullable().optional().default(null),
});

export const HIGH_LEVEL_ACTIONS = [
  "accept_cookies",
  "dismiss_overlay",
  "click_apply",
  "click_modal",
  "upload_resume",
  "smart_fill",
  "click_continue",
  "click_submit",
  "wait",
  "done",
  "wait_user",
];

export const GENERIC_ACTIONS = [
  "click",
  "fill",
  "goto",
  "press",
  "scroll",
  "select",
  "check",
  "uncheck",
  "upload",
];

export const AgentPlanSchema = z.object({
  action: z.string().max(80),
  elementIndex: z.number().int().nonnegative().optional(),
  target: z.string().max(240).optional(),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  url: z.string().max(2000).optional(),
  reason: z.string().max(400).optional(),
});

export const EndStateResponseSchema = z.object({
  action: z.enum([...RECOVERY_ACTIONS, "manual"]),
  target: z.string().max(200).optional().default(""),
  reason: z.string().max(240).optional().default("end-state assessor"),
});

/** Strip markdown fences and parse JSON with a Zod schema. */
export function parseJsonFromLlm(text, schema) {
  if (text == null) return null;
  let raw = String(text).trim();
  if (!raw) return null;
  if (raw.startsWith("```")) {
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) raw = fenced[1].trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) raw = raw.slice(start, end + 1);
  try {
    const data = JSON.parse(raw);
    const parsed = schema.safeParse(data);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
