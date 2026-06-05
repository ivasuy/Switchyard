import { z } from "zod";
import { accountIdSchema, isoDateSchema, organizationIdSchema, tenantIdSchema, userIdSchema } from "./ids.js";

export const userStatusSchema = z.enum(["active", "suspended", "deleted"]);

export const userSchema = z.object({
  id: userIdSchema,
  accountId: accountIdSchema.optional(),
  tenantId: tenantIdSchema.optional(),
  organizationId: organizationIdSchema.optional(),
  displayName: z.string().min(1),
  email: z.string().email().optional(),
  status: userStatusSchema.optional(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema.optional()
});

export type User = z.infer<typeof userSchema>;
