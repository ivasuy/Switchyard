import { z } from "zod";
import { isoDateSchema, nodeIdSchema } from "./ids.js";

export const nodeStatusSchema = z.enum(["online", "offline", "degraded", "unknown"]);

export const nodeSchema = z.object({
  id: nodeIdSchema,
  mode: z.enum(["local", "hosted", "hybrid"]),
  status: nodeStatusSchema,
  capabilities: z.array(z.string()),
  createdAt: isoDateSchema,
  lastSeenAt: isoDateSchema.optional()
});

export type ConnectedNode = z.infer<typeof nodeSchema>;
