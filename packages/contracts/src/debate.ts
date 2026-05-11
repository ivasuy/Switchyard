import { z } from "zod";
import { debateIdSchema, isoDateSchema, participantIdSchema, runIdSchema } from "./ids.js";

export const debateModeSchema = z.enum(["cross_provider_debate", "same_provider_model_debate", "same_provider_claude_debate", "mixed_model_panel", "judge_and_jury", "research_debate"]);
export const debateStatusSchema = z.enum(["created", "context_building", "researching", "arguing", "rebuttal", "judging", "consensus_found", "no_consensus", "stopped_by_user", "completed", "failed"]);
export const participantStatusSchema = z.enum(["created", "starting", "running", "completed", "failed", "cancelled"]);

export const debateParticipantSchema = z.object({
  id: participantIdSchema,
  runId: runIdSchema.optional(),
  runtime: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  role: z.string().min(1),
  status: participantStatusSchema,
  turnsUsed: z.number().int().nonnegative()
});

export const debateLimitsSchema = z.object({
  maxRounds: z.number().int().positive(),
  maxTurnsPerAgent: z.number().int().positive(),
  maxSearchesPerAgent: z.number().int().nonnegative(),
  maxTotalMessages: z.number().int().positive(),
  maxDurationSeconds: z.number().int().positive(),
  maxCostUsd: z.number().nonnegative(),
  requireCitations: z.boolean(),
  requireDisagreementSummary: z.boolean(),
  stopOnConsensus: z.boolean(),
  stopOnLowNewInformation: z.boolean(),
  humanStopAllowed: z.boolean()
});

export const debateSchema = z.object({
  id: debateIdSchema,
  topic: z.string().min(1),
  mode: debateModeSchema,
  status: debateStatusSchema,
  participants: z.array(debateParticipantSchema),
  limits: debateLimitsSchema,
  finalReportPath: z.string().optional(),
  createdAt: isoDateSchema,
  completedAt: isoDateSchema.optional()
});

export type Debate = z.infer<typeof debateSchema>;
