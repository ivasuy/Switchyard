import { z } from "zod";
import { contextPacketIdSchema, evidenceIdSchema, isoDateSchema, memoryIdSchema } from "./ids.js";

export const contextSectionSchema = z.object({
  name: z.string().min(1),
  content: z.string(),
  memoryIds: z.array(memoryIdSchema).default([]),
  evidenceIds: z.array(evidenceIdSchema).default([])
});

export const contextPacketSchema = z.object({
  id: contextPacketIdSchema,
  target: z.enum(["run", "debate", "participant", "tool"]),
  sections: z.array(contextSectionSchema),
  createdAt: isoDateSchema
});

export type ContextPacket = z.infer<typeof contextPacketSchema>;
