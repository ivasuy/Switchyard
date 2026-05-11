import { z } from "zod";
import { approvalIdSchema, isoDateSchema, runIdSchema } from "./ids.js";

export const approvalStatusSchema = z.enum(["pending", "approved", "rejected", "expired"]);
export const approvalTypeSchema = z.enum(["before_commit", "before_push", "before_pr", "before_destructive_command", "before_external_web_action", "before_external_message", "before_spending_budget", "before_cross_runtime_delegation", "before_same_provider_model_delegation"]);

export const approvalSchema = z.object({
  id: approvalIdSchema,
  runId: runIdSchema.optional(),
  approvalType: approvalTypeSchema,
  status: approvalStatusSchema,
  payload: z.record(z.string(), z.unknown()),
  createdAt: isoDateSchema,
  resolvedAt: isoDateSchema.optional()
});

export type Approval = z.infer<typeof approvalSchema>;
