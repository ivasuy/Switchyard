import { z } from "zod";
import { artifactIdSchema, debateIdSchema, evidenceIdSchema, isoDateSchema, messageIdSchema, participantIdSchema, runIdSchema, eventIdSchema } from "./ids.js";
import { budgetSchema } from "./budget.js";

export const debateModeSchema = z.enum(["cross_provider_debate", "same_provider_model_debate", "same_provider_claude_debate", "mixed_model_panel", "judge_and_jury", "research_debate"]);
export const debateStatusSchema = z.enum(["created", "context_building", "researching", "arguing", "rebuttal", "judging", "consensus_found", "no_consensus", "stopped_by_user", "completed", "failed"]);
export const participantStatusSchema = z.enum(["created", "starting", "running", "completed", "failed", "cancelled"]);
export const debateStopReasonSchema = z.enum([
  "max_rounds",
  "max_total_messages",
  "max_turns_per_agent",
  "max_duration_seconds",
  "max_cost_usd",
  "consensus",
  "completed",
  "failed"
]);

export const debateJudgeConsensusSchema = z.enum(["consensus_found", "no_consensus"]);
export const debateJudgeSchema = z.object({
  consensus: debateJudgeConsensusSchema,
  summary: z.string().min(1),
  disagreementSummary: z.string().min(1),
  winner: z.literal("none"),
  evidenceIds: z.array(evidenceIdSchema).default([]),
  messageIds: z.array(messageIdSchema).default([])
});

export const debateParticipantSchema = z.object({
  id: participantIdSchema,
  runId: runIdSchema.optional(),
  runIds: z.array(runIdSchema).default([]),
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
  evidenceIds: z.array(evidenceIdSchema).default([]),
  messageIds: z.array(messageIdSchema).default([]),
  eventIds: z.array(eventIdSchema).default([]),
  finalReportArtifactId: artifactIdSchema.optional(),
  finalReportPath: z.string().optional(),
  stopReason: debateStopReasonSchema.optional(),
  judge: debateJudgeSchema.optional(),
  budget: budgetSchema,
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema.optional(),
  completedAt: isoDateSchema.optional(),
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1)
  }).optional()
});

export type Debate = z.infer<typeof debateSchema>;
