import { z } from "zod";
import { isoDateSchema, messageIdSchema, runIdSchema } from "./ids.js";

export const deliveryStatusSchema = z.enum(["queued", "delivered", "failed", "cancelled"]);

export const messageSchema = z.object({
  id: messageIdSchema,
  fromRunId: runIdSchema.optional(),
  toRunId: runIdSchema.optional(),
  channel: z.string().min(1).optional(),
  content: z.string().min(1),
  attachments: z.array(z.record(z.string(), z.unknown())).default([]),
  deliveryStatus: deliveryStatusSchema,
  createdAt: isoDateSchema,
  deliveredAt: isoDateSchema.optional()
});

export type RoutedMessage = z.infer<typeof messageSchema>;
