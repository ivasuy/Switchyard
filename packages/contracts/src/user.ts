import { z } from "zod";
import { isoDateSchema, organizationIdSchema, userIdSchema } from "./ids.js";

export const userSchema = z.object({
  id: userIdSchema,
  organizationId: organizationIdSchema.optional(),
  displayName: z.string().min(1),
  createdAt: isoDateSchema
});

export type User = z.infer<typeof userSchema>;
