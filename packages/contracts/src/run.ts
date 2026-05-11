import { z } from "zod";
import { isoDateSchema, metadataSchema, runIdSchema } from "./ids.js";

export const adapterTypeSchema = z.enum(["native", "acpx", "http", "webhook", "process", "pty", "browser"]);
export const runStatusSchema = z.enum([
  "queued",
  "starting",
  "running",
  "waiting_for_input",
  "waiting_for_approval",
  "completed",
  "failed",
  "cancelled",
  "timeout"
]);
export const executionPlacementSchema = z.enum(["local", "hosted", "connected_local_node"]);

export const runSchema = z.object({
  id: runIdSchema,
  runtime: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  adapterType: adapterTypeSchema,
  cwd: z.string().min(1),
  task: z.string().min(1),
  status: runStatusSchema,
  placement: executionPlacementSchema,
  approvalPolicy: z.string().min(1),
  timeoutSeconds: z.number().int().positive(),
  metadata: metadataSchema.default({}),
  createdAt: isoDateSchema,
  startedAt: isoDateSchema.optional(),
  endedAt: isoDateSchema.optional()
});

export type Run = z.infer<typeof runSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type AdapterType = z.infer<typeof adapterTypeSchema>;
