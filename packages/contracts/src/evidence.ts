import { z } from "zod";
import { debateIdSchema, evidenceIdSchema, isoDateSchema } from "./ids.js";

export const evidenceSourceTypeSchema = z.enum(["url", "file", "search_result", "browser_capture", "repo", "artifact", "manual"]);
export const evidenceReliabilitySchema = z.enum(["primary", "secondary", "uncertain", "conflicting", "unknown"]);

export const evidenceItemSchema = z.object({
  id: evidenceIdSchema,
  debateId: debateIdSchema.optional(),
  sourceType: evidenceSourceTypeSchema,
  url: z.string().url().optional(),
  title: z.string().min(1),
  snippet: z.string().optional(),
  fetchedContentPath: z.string().optional(),
  reliability: evidenceReliabilitySchema,
  createdAt: isoDateSchema
});

export type EvidenceItem = z.infer<typeof evidenceItemSchema>;
