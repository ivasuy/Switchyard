import { z } from "zod";
import { artifactIdSchema, debateIdSchema, evidenceIdSchema, isoDateSchema, messageIdSchema, participantIdSchema, runIdSchema, eventIdSchema } from "./ids.js";
import { budgetSchema } from "./budget.js";
import { executionPlacementSchema } from "./run.js";

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
  budget: budgetSchema.default({
    status: "within_budget",
    maxCostUsd: 0,
    spentCostUsd: 0
  }),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema.optional(),
  completedAt: isoDateSchema.optional(),
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1)
  }).optional()
});

export type Debate = z.infer<typeof debateSchema>;

const FAKE_DEBATE_PARTICIPANT_DEFAULTS = {
  runtime: "fake",
  provider: "test",
  model: "test-model",
  adapterType: "process",
  runtimeMode: "fake.deterministic",
  placement: "local",
  realRuntimeOptIn: false
} as const;

export const createDebateParticipantInputSchema = z
  .object({
    role: z.string().min(1),
    runtime: z.string().min(1).default(FAKE_DEBATE_PARTICIPANT_DEFAULTS.runtime),
    provider: z.string().min(1).default(FAKE_DEBATE_PARTICIPANT_DEFAULTS.provider),
    model: z.string().min(1).default(FAKE_DEBATE_PARTICIPANT_DEFAULTS.model),
    adapterType: z.string().min(1).default(FAKE_DEBATE_PARTICIPANT_DEFAULTS.adapterType),
    runtimeMode: z.string().min(1).default(FAKE_DEBATE_PARTICIPANT_DEFAULTS.runtimeMode),
    placement: executionPlacementSchema.default(FAKE_DEBATE_PARTICIPANT_DEFAULTS.placement),
    realRuntimeOptIn: z.boolean().default(FAKE_DEBATE_PARTICIPANT_DEFAULTS.realRuntimeOptIn)
  })
  .passthrough();

export const deterministicJudgeConfigSchema = z
  .object({
    mode: z.literal("deterministic")
  })
  .passthrough();

export const modelJudgeConfigSchema = z
  .object({
    mode: z.literal("model"),
    runtime: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    adapterType: z.string().min(1).optional(),
    runtimeMode: z.string().min(1).optional(),
    placement: executionPlacementSchema.optional(),
    realRuntimeOptIn: z.literal(true),
    confirmLiveProviderSpend: z.literal(true)
  })
  .passthrough();

export const debateJudgeConfigSchema = z.discriminatedUnion("mode", [
  deterministicJudgeConfigSchema,
  modelJudgeConfigSchema
]);

export const createDebateRequestSchema = z
  .object({
    topic: z.string().min(1),
    participants: z.array(createDebateParticipantInputSchema).length(2),
    judgeConfig: debateJudgeConfigSchema.default({ mode: "deterministic" }),
    evidenceIds: z.array(evidenceIdSchema).default([]),
    limits: debateLimitsSchema.partial().optional()
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (Object.prototype.hasOwnProperty.call(value, "judge")) {
      ctx.addIssue({
        code: "custom",
        path: ["judge"],
        message: "field is reserved"
      });
    }
  });

export type CreateDebateRequest = z.infer<typeof createDebateRequestSchema>;
