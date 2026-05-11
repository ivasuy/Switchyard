import { z } from "zod";
import { artifactIdSchema, debateIdSchema, isoDateSchema, metadataSchema, runIdSchema } from "./ids.js";

export const artifactTypeSchema = z.enum(["transcript", "debate_transcript", "model_transcript", "raw_log", "event_log", "evidence_pack", "diff", "screenshot", "test_log", "proof", "summary"]);

export const artifactSchema = z.object({
  id: artifactIdSchema,
  runId: runIdSchema.optional(),
  debateId: debateIdSchema.optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  type: artifactTypeSchema,
  path: z.string().min(1),
  metadata: metadataSchema.default({}),
  createdAt: isoDateSchema
});

export type Artifact = z.infer<typeof artifactSchema>;
