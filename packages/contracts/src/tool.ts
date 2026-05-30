import { z } from "zod";
import { approvalIdSchema, isoDateSchema, runIdSchema, toolInvocationIdSchema } from "./ids.js";

export const toolTypeSchema = z.enum(["web_search", "fetch", "browser", "repo", "shell", "github", "fake_echo"]);
export const toolInvocationStatusSchema = z.enum(["queued", "running", "completed", "failed", "cancelled", "denied"]);

export const toolInvocationSchema = z.object({
  id: toolInvocationIdSchema,
  runId: runIdSchema.optional(),
  type: toolTypeSchema,
  status: toolInvocationStatusSchema,
  approvalId: approvalIdSchema.optional(),
  input: z.record(z.string(), z.unknown()),
  output: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ code: z.string().min(1), message: z.string().min(1) }).optional(),
  createdAt: isoDateSchema,
  completedAt: isoDateSchema.optional()
});

export type ToolInvocation = z.infer<typeof toolInvocationSchema>;
