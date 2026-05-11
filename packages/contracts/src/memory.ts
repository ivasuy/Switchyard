import { z } from "zod";
import { debateIdSchema, isoDateSchema, memoryIdSchema, metadataSchema, runIdSchema } from "./ids.js";

export const memoryScopeSchema = z.enum(["user", "project", "runtime", "provider_model", "debate", "participant", "swarm_channel"]);

export const memoryItemSchema = z.object({
  id: memoryIdSchema,
  scope: memoryScopeSchema,
  projectId: z.string().optional(),
  runId: runIdSchema.optional(),
  debateId: debateIdSchema.optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  content: z.string().min(1),
  metadata: metadataSchema.default({}),
  embedding: z.array(z.number()).optional(),
  createdAt: isoDateSchema
});

export type MemoryItem = z.infer<typeof memoryItemSchema>;
