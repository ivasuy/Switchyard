import { z } from "zod";
import { isoDateSchema, runIdSchema, runtimeModeSlugSchema, sessionIdSchema } from "./ids.js";

export const runtimeProtocolSchema = z.enum(["native", "acpx", "http", "webhook", "process", "pty", "browser"]);
export const runtimeSessionStatusSchema = z.enum(["created", "active", "waiting_for_input", "waiting_for_approval", "completed", "failed", "cancelled"]);

export const runtimeSessionSchema = z.object({
  id: sessionIdSchema,
  runId: runIdSchema,
  runtime: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  protocol: runtimeProtocolSchema,
  status: runtimeSessionStatusSchema,
  externalSessionKey: z.string().min(1).optional(),
  processId: z.number().int().positive().optional(),
  runtimeMode: runtimeModeSlugSchema.nullable().optional(),
  state: z.record(z.string(), z.unknown()).default({}),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema.optional()
});

export type RuntimeSession = z.infer<typeof runtimeSessionSchema>;
