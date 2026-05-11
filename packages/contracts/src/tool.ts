import { z } from "zod";
import { isoDateSchema, runIdSchema, toolInvocationIdSchema } from "./ids.js";

export const toolTypeSchema = z.enum(["web_search", "fetch", "browser", "repo", "shell", "github"]);
export const toolInvocationStatusSchema = z.enum(["queued", "running", "completed", "failed", "cancelled", "denied"]);

export const toolInvocationSchema = z.object({
  id: toolInvocationIdSchema,
  runId: runIdSchema.optional(),
  type: toolTypeSchema,
  status: toolInvocationStatusSchema,
  input: z.record(z.string(), z.unknown()),
  output: z.record(z.string(), z.unknown()).optional(),
  createdAt: isoDateSchema,
  completedAt: isoDateSchema.optional()
});

export type ToolInvocation = z.infer<typeof toolInvocationSchema>;
