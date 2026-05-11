import { z } from "zod";
import { debateIdSchema, eventIdSchema, isoDateSchema, participantIdSchema, providerIdSchema, runIdSchema } from "./ids.js";

export const eventTypeSchema = z.enum([
  "run.queued",
  "run.started",
  "runtime.output",
  "runtime.status",
  "tool.call",
  "tool.result",
  "message.sent",
  "artifact.created",
  "debate.round.started",
  "debate.agent.argument",
  "debate.agent.rebuttal",
  "debate.evidence.added",
  "debate.judge.summary",
  "debate.consensus",
  "approval.requested",
  "run.completed",
  "run.failed"
]);

export const eventSchema = z.object({
  id: eventIdSchema,
  type: eventTypeSchema,
  runId: runIdSchema.optional(),
  debateId: debateIdSchema.optional(),
  participantId: participantIdSchema.optional(),
  provider: providerIdSchema.or(z.string()).optional(),
  model: z.string().optional(),
  sequence: z.number().int().nonnegative(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: isoDateSchema
});

export type SwitchyardEvent = z.infer<typeof eventSchema>;
export type EventType = z.infer<typeof eventTypeSchema>;
