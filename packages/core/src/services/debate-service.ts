import type { Artifact, AuthContext, Debate, EvidenceItem, RoutedMessage, Run, SwitchyardEvent } from "@switchyard/contracts";
import type { ArtifactStore } from "../ports/artifact-store.js";
import type { DebateExecutionJob, DebateExecutionStore } from "../ports/debate-execution-store.js";
import type { DebateStore } from "../ports/debate-store.js";
import type { EventStore } from "../ports/event-store.js";
import type { EvidenceStore } from "../ports/evidence-store.js";
import type { RunStore } from "../ports/run-store.js";
import type { RuntimeLogger } from "../ports/runtime-logger.js";
import type { ContextBuilder } from "./context-builder.js";
import {
  buildDebateChildRunKey,
  buildDebateChildRunMetadata,
  normalizeDebateRuntime,
  type DebateParticipantRuntimeConfig,
  type DebateRunKind
} from "./debate-runtime-matrix.js";
import {
  classifyDebateRuntimeOutputTiming,
  extractDebateRuntimeOutput,
  isTerminalDebateStatus
} from "./debate-output.js";
import { DebateJudgeRunner, type DebateJudgeRunnerConfig } from "./debate-judge-runner.js";
import type { EventBus } from "./event-bus.js";
import type { MessageRouter } from "./message-router.js";
import type { RunService } from "./run-service.js";

type ServiceDetail = { path: string; issue: string };

export class DebateServiceError extends Error {
  readonly code: string;
  readonly details?: ServiceDetail[];

  constructor(code: string, message: string, details?: ServiceDetail[]) {
    super(message);
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export interface CreateDebateInput {
  topic: string;
  participants: Array<{
    role: string;
    runtime?: string;
    provider?: string;
    model?: string;
    adapterType?: string;
    runtimeMode?: string;
    placement?: Run["placement"];
    realRuntimeOptIn?: boolean;
  }>;
  judgeConfig?: DebateJudgeRunnerConfig & {
    runtime?: string;
    provider?: string;
    model?: string;
    adapterType?: string;
    runtimeMode?: string;
    placement?: Run["placement"];
    realRuntimeOptIn?: boolean;
  };
  evidenceIds?: string[];
  limits?: Partial<Debate["limits"]>;
}

export interface DebateCreateOptions {
  wait?: boolean;
  auth?: AuthContext;
  requestId?: string;
}

export interface DebateQuotaFinalization {
  debateId: string;
  outcome: "completed" | "failed";
  reasonCode?: string;
}

export type ProcessExecutionJobResult =
  | { action: "complete"; reasonCode?: string; quotaFinalization?: DebateQuotaFinalization; debateId: string; runId?: string; judgeRunId?: string }
  | { action: "requeue"; reasonCode: string; nextAttemptAt: string; debateId: string; runId?: string; judgeRunId?: string }
  | { action: "fail"; reasonCode: string; quotaFinalization: DebateQuotaFinalization; debateId: string };

export interface DebateServiceDependencies {
  debates: DebateStore;
  runs: RunStore;
  runService: Pick<RunService, "createRun" | "startRun">;
  contextBuilder: Pick<ContextBuilder, "build">;
  messageRouter: Pick<MessageRouter, "createWithEvent" | "get">;
  evidence: EvidenceStore;
  events: EventStore;
  artifacts: ArtifactStore;
  debateExecution?: DebateExecutionStore;
  debateJudgeRunner?: DebateJudgeRunner;
  hosted?: {
    authorizeEvidence?: (input: { evidenceId: string; auth: AuthContext; requestId?: string }) => Promise<void | { ok: boolean }>;
  };
  artifactContent?: {
    writeText(path: string, content: string): Promise<string>;
  };
  eventBus?: EventBus;
  logger?: RuntimeLogger;
  defaultCwd: string;
}

export interface DebateInspectResult {
  debate: Debate;
  events: SwitchyardEvent[];
  messages: RoutedMessage[];
  evidence: EvidenceItem[];
  artifacts: Artifact[];
}

type DebateParticipantRecord = Debate["participants"][number];
type DebateParticipantWithRuntimeConfig = DebateParticipantRecord & Partial<DebateParticipantRuntimeConfig>;
type DebateWithRuntimeConfig = Debate & { judgeConfig?: ParsedCreateInput["judgeConfig"] };

interface ParsedCreateInput {
  topic: string;
  participants: Array<{
    role: string;
    runtime: string;
    provider: string;
    model: string;
    adapterType: Run["adapterType"];
    runtimeMode: string;
    placement: Run["placement"];
    realRuntimeOptIn: boolean;
    isRealRuntime: boolean;
  }>;
  judgeConfig: DebateJudgeRunnerConfig & {
    runtime: string;
    provider: string;
    model: string;
    adapterType: Run["adapterType"];
    runtimeMode: string;
    placement: Run["placement"];
    realRuntimeOptIn: boolean;
    isLiveJudge: boolean;
  };
  evidenceIds: string[];
  limits: Debate["limits"];
}

const DEFAULT_LIMITS: Debate["limits"] = {
  maxRounds: 2,
  maxTurnsPerAgent: 2,
  maxSearchesPerAgent: 0,
  maxTotalMessages: 4,
  maxDurationSeconds: 30,
  maxCostUsd: 0,
  requireCitations: false,
  requireDisagreementSummary: true,
  stopOnConsensus: false,
  stopOnLowNewInformation: false,
  humanStopAllowed: false
};

const RESERVED_CREATE_FIELDS = new Set([
  "id",
  "status",
  "messageIds",
  "eventIds",
  "judge",
  "budget",
  "finalReportArtifactId",
  "finalReportPath",
  "createdAt",
  "updatedAt",
  "completedAt"
]);

const FAKE_RUNTIME = {
  runtime: "fake",
  provider: "test",
  model: "test-model",
  adapterType: "process",
  runtimeMode: "fake.deterministic"
} as const;

const MAX_PARTICIPANT_OUTPUT_BYTES = 16 * 1024;
const MAX_JUDGE_OUTPUT_BYTES = 8 * 1024;

export class DebateService {
  private readonly judgeRunner: DebateJudgeRunner;

  constructor(private readonly deps: DebateServiceDependencies) {
    this.judgeRunner = deps.debateJudgeRunner ?? new DebateJudgeRunner();
  }

  async create(input: unknown, options: DebateCreateOptions = {}): Promise<{
    debate: Debate;
    events?: SwitchyardEvent[];
    finalReportArtifact?: Artifact | null;
  }> {
    const parsed = await this.parseCreateInput(input, options);
    if (options.wait && (parsed.participants.some((participant) => participant.isRealRuntime) || parsed.judgeConfig.isLiveJudge)) {
      this.deps.logger?.warn("debate.create.denied", {
        reasonCode: "debate_wait_real_runtime_unsupported",
        hasRealParticipant: parsed.participants.some((participant) => participant.isRealRuntime),
        hasLiveJudge: parsed.judgeConfig.isLiveJudge
      });
      throw new DebateServiceError(
        "debate_wait_real_runtime_unsupported",
        "wait=true is only supported for no-spend fake deterministic debates"
      );
    }

    const now = new Date().toISOString();
    const debate: Debate = {
      id: `debate_${crypto.randomUUID()}`,
      topic: parsed.topic,
      mode: "same_provider_model_debate",
      status: "created",
      participants: parsed.participants.map((participant) => ({
        id: `participant_${crypto.randomUUID()}`,
        runtime: participant.runtime,
        provider: participant.provider,
        model: participant.model,
        role: participant.role,
        status: "created",
        turnsUsed: 0,
        runIds: [],
        adapterType: participant.adapterType,
        runtimeMode: participant.runtimeMode,
        placement: participant.placement,
        realRuntimeOptIn: participant.realRuntimeOptIn,
        isRealRuntime: participant.isRealRuntime
      })),
      limits: parsed.limits,
      evidenceIds: parsed.evidenceIds,
      messageIds: [],
      eventIds: [],
      budget: {
        status: "within_budget",
        maxCostUsd: 0,
        spentCostUsd: 0
      },
      createdAt: now,
      updatedAt: now
    };
    (debate as DebateWithRuntimeConfig).judgeConfig = parsed.judgeConfig;

    await this.deps.debates.create(debate);
    this.deps.logger?.info("debate.create.accepted", {
      debateId: debate.id,
      placementSummary: parsed.participants.map((participant) => participant.placement).join(","),
      realParticipantCount: parsed.participants.filter((participant) => participant.isRealRuntime).length,
      judgeMode: parsed.judgeConfig.mode ?? "deterministic"
    });
    for (const evidenceId of debate.evidenceIds) {
      const event = await this.appendDebateEvent(debate, "debate.evidence.added", { evidenceId });
      debate.eventIds.push(event.id);
      debate.updatedAt = new Date().toISOString();
      await this.deps.debates.update(debate);
    }

    if (!options.wait) {
      if (this.deps.debateExecution) {
        await this.deps.debateExecution.enqueue({
          debateId: debate.id,
          stage: "participant_turn",
          debateRound: 1,
          debatePhase: "arguing",
          participantIndex: 0,
          ...ownershipFieldsFromAuth(options.auth)
        });
      }
      return { debate };
    }

    const executed = await this.execute(debate.id, { judgeConfig: parsed.judgeConfig });
    const events = await this.listEvents(debate.id);
    const finalReportArtifact = executed.finalReportArtifactId
      ? await this.deps.artifacts.get(executed.finalReportArtifactId)
      : null;
    return {
      debate: executed,
      events,
      finalReportArtifact: finalReportArtifact ?? null
    };
  }

  async execute(debateId: string, options: { judgeConfig?: ParsedCreateInput["judgeConfig"] } = {}): Promise<Debate> {
    const debate = await this.requireDebate(debateId);
    if (isTerminalDebateStatus(debate.status)) {
      return debate;
    }

    const startedAt = Date.now();
    const evidence = await this.loadEvidenceRecords(debate.evidenceIds);

    try {
      await this.createParticipantRuns(debate, evidence);
      await this.executeRounds(debate, startedAt);
      await this.finishJudgingAndReport(debate, evidence, options.judgeConfig);
      return await this.requireDebate(debate.id);
    } catch (error) {
      const serviceError = toServiceError(error, "debate_execution_failed");
      await this.finalizeFailedDebate(debate, evidence, serviceError);
      throw serviceError;
    }
  }

  async inspect(debateId: string): Promise<DebateInspectResult> {
    const debate = await this.requireDebate(debateId);
    const events = await this.deps.events.listByDebate(debateId);
    const messages: RoutedMessage[] = [];
    for (const messageId of debate.messageIds) {
      const message = await this.deps.messageRouter.get(messageId);
      if (message) {
        messages.push(message);
      }
    }
    const evidence = await this.loadEvidenceRecords(debate.evidenceIds);
    const artifacts = await this.deps.artifacts.listByDebate(debateId);
    return { debate, events, messages, evidence, artifacts };
  }

  async listEvents(debateId: string): Promise<SwitchyardEvent[]> {
    await this.requireDebate(debateId);
    return this.deps.events.listByDebate(debateId);
  }

  async processExecutionJob(job: DebateExecutionJob): Promise<ProcessExecutionJobResult> {
    try {
      const debate = await this.requireDebate(job.debateId);
      if (isTerminalDebateStatus(debate.status)) {
        const reasonCode = debate.error?.code ?? debate.stopReason;
        return {
          action: "complete",
          debateId: debate.id,
          ...(reasonCode ? { reasonCode } : {}),
          quotaFinalization: quotaFinalizationFor(debate)
        };
      }

      if (job.stage === "judging") {
        return await this.processJudgingJob(job, debate);
      }
      return await this.processParticipantTurnJob(job, debate);
    } catch (error) {
      const serviceError = toServiceError(error, "debate_execution_failed");
      const debate = await this.deps.debates.get(job.debateId);
      if (debate) {
        await this.finalizeFailedDebate(debate, await this.loadEvidenceRecords(debate.evidenceIds), serviceError);
      }
      return {
        action: "fail",
        debateId: job.debateId,
        reasonCode: serviceError.code,
        quotaFinalization: {
          debateId: job.debateId,
          outcome: "failed",
          reasonCode: serviceError.code
        }
      };
    }
  }

  private async processParticipantTurnJob(job: DebateExecutionJob, debate: Debate): Promise<ProcessExecutionJobResult> {
    const participantIndex = job.participantIndex ?? 0;
    const participant = debate.participants[participantIndex] as DebateParticipantWithRuntimeConfig | undefined;
    const other = debate.participants[(participantIndex + 1) % debate.participants.length];
    if (!participant || !other) {
      throw new DebateServiceError("invalid_input", "Debate participant index is invalid");
    }

    debate.status = job.debatePhase === "rebuttal" ? "rebuttal" : "arguing";
    debate.updatedAt = new Date().toISOString();
    await this.deps.debates.update(debate);

    const run = await this.createOrRelinkChildRun({
      job,
      debate,
      participant,
      debateRunKind: "participant",
      debateRound: job.debateRound,
      debatePhase: job.debatePhase || "arguing",
      task: buildParticipantTurnTask(debate, participant, job.debateRound, job.debatePhase || "arguing"),
      judgeConfig: undefined
    });

    if (!isTerminalRunStatus(run.status)) {
      return {
        action: "requeue",
        debateId: debate.id,
        reasonCode: "debate_child_run_pending",
        nextAttemptAt: nextAttemptAt(),
        runId: run.id
      };
    }
    if (run.status !== "completed") {
      throw new DebateServiceError(runStatusToParticipantFailureCode(run.status), `Participant run did not complete: ${run.status}`);
    }

    const fresh = await this.requireDebate(debate.id);
    const timing = classifyDebateRuntimeOutputTiming({ debateStatus: fresh.status });
    if (!timing.canRouteMessage) {
      await this.appendDebateEvent(fresh, "runtime.status", {
        status: "late_output_ignored",
        runId: run.id,
        reasonCode: "debate_terminal"
      });
      this.deps.logger?.warn("debate.participant.output.late", {
        debateId: debate.id,
        runId: run.id,
        status: fresh.status
      });
      return {
        action: "complete",
        debateId: fresh.id,
        reasonCode: "debate_late_output_ignored",
        quotaFinalization: quotaFinalizationFor(fresh)
      };
    }

    const childRunKey = buildDebateChildRunKey({
      debateId: debate.id,
      participantId: participant.id,
      debateRound: job.debateRound,
      debatePhase: job.debatePhase || "arguing",
      debateRunKind: "participant"
    });
    const output = extractDebateRuntimeOutput(await this.deps.events.listByRun(run.id), {
      debateId: debate.id,
      childRunKey,
      maxBytes: MAX_PARTICIPANT_OUTPUT_BYTES,
      runId: run.id
    });
    if (!output.ok) {
      throw new DebateServiceError(output.code, output.message);
    }

    const routed = await this.deps.messageRouter.createWithEvent({
      debateId: debate.id,
      participantId: participant.id,
      fromRunId: run.id,
      toRunId: other.runId ?? run.id,
      channel: `debate:${debate.id}`,
      content: output.text,
      attachments: [
        {
          type: "debate_turn",
          debateId: debate.id,
          participantId: participant.id,
          round: job.debateRound,
          phase: job.debatePhase || "arguing",
          evidenceIds: debate.evidenceIds,
          runtimeOutputEventId: output.eventId
        }
      ]
    });

    fresh.messageIds.push(routed.message.id);
    fresh.eventIds.push(routed.event.id);
    const freshParticipant = fresh.participants[participantIndex]!;
    freshParticipant.runId = run.id;
    freshParticipant.runIds.push(run.id);
    freshParticipant.status = "completed";
    freshParticipant.turnsUsed += 1;
    const turnEvent = await this.appendDebateEvent(
      fresh,
      job.debateRound === 1 ? "debate.agent.argument" : "debate.agent.rebuttal",
      {
        round: job.debateRound,
        phase: job.debatePhase || "arguing",
        participantId: participant.id,
        runId: run.id,
        messageId: routed.message.id
      }
    );
    fresh.eventIds.push(turnEvent.id);
    fresh.updatedAt = new Date().toISOString();
    await this.deps.debates.update(fresh);

    const nextJob = nextDebateJob(fresh, job);
    if (fresh.stopReason) {
      fresh.updatedAt = new Date().toISOString();
      await this.deps.debates.update(fresh);
    }
    if (nextJob) {
      await this.deps.debateExecution?.enqueue({ debateId: fresh.id, ...nextJob });
    } else {
      await this.deps.debateExecution?.enqueue({
        debateId: fresh.id,
        stage: "judging",
        debateRound: job.debateRound,
        debatePhase: "judging"
      });
    }
    return { action: "complete", debateId: fresh.id, runId: run.id };
  }

  private async processJudgingJob(job: DebateExecutionJob, debate: Debate): Promise<ProcessExecutionJobResult> {
    const evidence = await this.loadEvidenceRecords(debate.evidenceIds);
    const judgeConfig = ((debate as DebateWithRuntimeConfig).judgeConfig ?? this.parseJudgeConfig(undefined));
    if (judgeConfig.mode !== "model") {
      await this.finishJudgingAndReport(debate, evidence, judgeConfig);
      const completed = await this.requireDebate(debate.id);
      return {
        action: "complete",
        debateId: completed.id,
        quotaFinalization: quotaFinalizationFor(completed)
      };
    }

    const run = await this.createOrRelinkChildRun({
      job,
      debate,
      participant: undefined,
      debateRunKind: "judge",
      debateRound: job.debateRound,
      debatePhase: "judging",
      task: buildJudgeTask(debate, await this.loadMessages(debate.messageIds)),
      judgeConfig
    });
    if (!isTerminalRunStatus(run.status)) {
      return {
        action: "requeue",
        debateId: debate.id,
        reasonCode: "debate_judge_run_pending",
        nextAttemptAt: nextAttemptAt(),
        judgeRunId: run.id
      };
    }
    if (run.status !== "completed") {
      throw new DebateServiceError("debate_judge_run_failed", `Judge run did not complete: ${run.status}`);
    }
    (debate as DebateWithRuntimeConfig & { judgeRunId?: string }).judgeRunId = run.id;
    debate.updatedAt = new Date().toISOString();
    await this.deps.debates.update(debate);

    const childRunKey = buildDebateChildRunKey({
      debateId: debate.id,
      judgeId: "judge:model",
      debateRound: job.debateRound,
      debatePhase: "judging",
      debateRunKind: "judge"
    });
    const output = extractDebateRuntimeOutput(await this.deps.events.listByRun(run.id), {
      debateId: debate.id,
      childRunKey,
      maxBytes: MAX_JUDGE_OUTPUT_BYTES,
      runId: run.id,
      outputKind: "judge"
    });
    if (!output.ok) {
      this.deps.logger?.warn("debate.judge.output.rejected", {
        debateId: debate.id,
        runId: run.id,
        reasonCode: output.code,
        outputBytes: output.outputBytes
      });
      throw new DebateServiceError(output.code, output.message);
    }

    debate.judge = this.judgeRunner.parseModelJudgeOutput(output.text, { maxBytes: MAX_JUDGE_OUTPUT_BYTES, debate });
    await this.finishJudgingAndReport(debate, evidence, judgeConfig, run.id);
    const completed = await this.requireDebate(debate.id);
    return {
      action: "complete",
      debateId: completed.id,
      judgeRunId: run.id,
      quotaFinalization: quotaFinalizationFor(completed)
    };
  }

  private async createOrRelinkChildRun(input: {
    job: DebateExecutionJob;
    debate: Debate;
    participant: DebateParticipantWithRuntimeConfig | undefined;
    debateRunKind: DebateRunKind;
    debateRound: number;
    debatePhase: string;
    task: string;
    judgeConfig: ParsedCreateInput["judgeConfig"] | undefined;
  }): Promise<Run> {
    const debateRound = input.job.debateRound;
    const childRunKey = buildDebateChildRunKey({
      debateId: input.debate.id,
      debateRound,
      debatePhase: input.debatePhase,
      debateRunKind: input.debateRunKind,
      ...(input.participant ? { participantId: input.participant.id } : {}),
      ...(input.debateRunKind === "judge" ? { judgeId: "judge:model" } : {})
    });

    const pendingRunId = input.debateRunKind === "judge" ? input.job.pendingJudgeRunId : input.job.pendingRunId;
    if (pendingRunId) {
      const pending = await this.deps.runs.get(pendingRunId);
      if (pending) {
        return pending;
      }
    }

    const linked = await this.deps.debateExecution?.findPendingRunByKey(childRunKey);
    if (linked) {
      const run = await this.deps.runs.get(linked.runId);
      if (run) {
        return run;
      }
    }

    const existing = await this.deps.runs.findByDebateChildRunKey?.(childRunKey);
    if (existing) {
      const link = await this.linkPendingRun(input.job, childRunKey, existing.id);
      if (!link.ok) {
        throw new DebateServiceError("debate_child_run_link_failed", `Could not link existing child run: ${link.reason}`);
      }
      return existing;
    }

    const runInput = this.buildChildRunInput(input, childRunKey);
    const createdResult = await this.deps.runService.createRun(runInput);
    const created = normalizeCreatedRun(createdResult);
    const link = await this.linkPendingRun(input.job, childRunKey, created.id);
    if (!link.ok) {
      const recovered = await this.deps.runs.findByDebateChildRunKey?.(childRunKey);
      if (recovered) {
        return recovered;
      }
      throw new DebateServiceError("debate_child_run_link_failed", `Could not link child run: ${link.reason}`);
    }
    this.deps.logger?.info(input.debateRunKind === "judge" ? "debate.judge.run.created" : "debate.participant.run.linked", {
      debateId: input.debate.id,
      participantId: input.participant?.id,
      runId: created.id,
      childRunKey,
      reused: false,
      judgeMode: input.judgeConfig?.mode,
      runtimeMode: created.runtimeMode
    });
    return created;
  }

  private buildChildRunInput(input: {
    debate: Debate;
    participant: DebateParticipantWithRuntimeConfig | undefined;
    debateRunKind: DebateRunKind;
    debateRound: number;
    debatePhase: string;
    task: string;
    judgeConfig: ParsedCreateInput["judgeConfig"] | undefined;
  }, childRunKey: string): Parameters<RunService["createRun"]>[0] {
    const config = input.participant ?? input.judgeConfig ?? this.parseJudgeConfig(undefined);
    const metadata = buildDebateChildRunMetadata({
      debateId: input.debate.id,
      debateRound: input.debateRound,
      debatePhase: input.debatePhase,
      debateRunKind: input.debateRunKind,
      ...(input.participant ? { participantId: input.participant.id, participantRole: input.participant.role } : {}),
      ...(input.debateRunKind === "judge" ? { judgeId: "judge:model" } : {})
    });
    metadata.debateChildRunKey = childRunKey;
    return {
      runtime: config.runtime ?? FAKE_RUNTIME.runtime,
      provider: config.provider ?? FAKE_RUNTIME.provider,
      model: config.model ?? FAKE_RUNTIME.model,
      adapterType: config.adapterType ?? FAKE_RUNTIME.adapterType,
      runtimeMode: config.runtimeMode ?? FAKE_RUNTIME.runtimeMode,
      cwd: this.deps.defaultCwd,
      task: input.task,
      placement: config.placement ?? "local",
      approvalPolicy: "default",
      timeoutSeconds: Math.min(60, input.debate.limits.maxDurationSeconds),
      metadata: {
        ...metadata,
        debateTopic: input.debate.topic,
        originalTask: input.task
      }
    };
  }

  private async linkPendingRun(job: DebateExecutionJob, childRunKey: string, runId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!this.deps.debateExecution) {
      return { ok: true };
    }
    const result = await this.deps.debateExecution.linkPendingRun(job.id, childRunKey, runId, job.stage);
    if (result.ok) {
      return { ok: true };
    }
    return { ok: false, reason: result.reason };
  }

  private async parseCreateInput(input: unknown, options: DebateCreateOptions): Promise<ParsedCreateInput> {
    if (!isRecord(input)) {
      throw new DebateServiceError("invalid_input", "Request body must be an object", [{ path: "body", issue: "must be an object" }]);
    }
    for (const key of Object.keys(input)) {
      if (RESERVED_CREATE_FIELDS.has(key)) {
        throw new DebateServiceError("invalid_input", `Reserved field is not allowed: ${key}`, [{ path: key, issue: "field is reserved" }]);
      }
    }

    const topicRaw = input["topic"];
    if (typeof topicRaw !== "string") {
      throw new DebateServiceError("invalid_input", "topic is required", [{ path: "topic", issue: "must be a non-empty string" }]);
    }
    const topic = topicRaw.trim();
    if (topic.length === 0) {
      throw new DebateServiceError("invalid_input", "topic is required", [{ path: "topic", issue: "must be a non-empty string" }]);
    }
    if (Buffer.byteLength(topic, "utf8") > 2048) {
      throw new DebateServiceError("invalid_input", "topic exceeds 2048 bytes", [{ path: "topic", issue: "must be <= 2048 UTF-8 bytes" }]);
    }

    const participantsRaw = input["participants"];
    if (!Array.isArray(participantsRaw) || participantsRaw.length !== 2) {
      throw new DebateServiceError("invalid_input", "participants must contain exactly two entries", [
        { path: "participants", issue: "must contain exactly two participants" }
      ]);
    }
    const participants = participantsRaw.map((raw, index) => this.parseParticipant(raw, index));

    const judgeConfig = this.parseJudgeConfig(input["judgeConfig"]);

    const evidenceIdsRaw = input["evidenceIds"];
    const evidenceIds = this.parseEvidenceIds(evidenceIdsRaw);
    await this.preauthorizeEvidenceReferences(evidenceIds, options);
    await this.validateEvidenceReferences(evidenceIds, options);

    const limits = this.parseLimits(input["limits"]);
    return { topic, participants, judgeConfig, evidenceIds, limits };
  }

  private parseParticipant(value: unknown, index: number): {
    role: string;
    runtime: string;
    provider: string;
    model: string;
    adapterType: Run["adapterType"];
    runtimeMode: string;
    placement: Run["placement"];
    realRuntimeOptIn: boolean;
    isRealRuntime: boolean;
  } {
    if (!isRecord(value)) {
      throw new DebateServiceError("invalid_input", "participant must be an object", [
        { path: `participants.${index}`, issue: "must be an object" }
      ]);
    }
    const roleRaw = value["role"];
    if (typeof roleRaw !== "string" || roleRaw.trim().length === 0) {
      throw new DebateServiceError("invalid_input", "participant role is required", [
        { path: `participants.${index}.role`, issue: "must be a non-empty string" }
      ]);
    }
    const role = roleRaw.trim();
    if (Buffer.byteLength(role, "utf8") > 64) {
      throw new DebateServiceError("invalid_input", "participant role exceeds 64 bytes", [
        { path: `participants.${index}.role`, issue: "must be <= 64 UTF-8 bytes" }
      ]);
    }

    try {
      const runtime = normalizeDebateRuntime(value, index);
      return { role, ...runtime };
    } catch (error) {
      throw toServiceError(error, "invalid_input");
    }
  }

  private parseJudgeConfig(value: unknown): ParsedCreateInput["judgeConfig"] {
    if (value === undefined || value === null) {
      return {
        mode: "deterministic",
        confirmLiveProviderSpend: false,
        runtime: FAKE_RUNTIME.runtime,
        provider: FAKE_RUNTIME.provider,
        model: FAKE_RUNTIME.model,
        adapterType: FAKE_RUNTIME.adapterType,
        runtimeMode: FAKE_RUNTIME.runtimeMode,
        placement: "local",
        realRuntimeOptIn: false,
        isLiveJudge: false
      };
    }
    if (!isRecord(value)) {
      throw new DebateServiceError("debate_judge_config_invalid", "judgeConfig must be an object", [
        { path: "judgeConfig", issue: "must be an object" }
      ]);
    }
    const mode = value["mode"];
    if (mode === undefined || mode === "deterministic") {
      return {
        mode: "deterministic",
        confirmLiveProviderSpend: false,
        runtime: FAKE_RUNTIME.runtime,
        provider: FAKE_RUNTIME.provider,
        model: FAKE_RUNTIME.model,
        adapterType: FAKE_RUNTIME.adapterType,
        runtimeMode: FAKE_RUNTIME.runtimeMode,
        placement: "local",
        realRuntimeOptIn: false,
        isLiveJudge: false
      };
    }
    if (mode !== "model") {
      throw new DebateServiceError("debate_judge_config_invalid", "judgeConfig.mode must be deterministic or model", [
        { path: "judgeConfig.mode", issue: "must be deterministic or model" }
      ]);
    }
    try {
      this.judgeRunner.assertModelJudgeSpendConfirmed({
        mode: "model",
        confirmLiveProviderSpend: value["confirmLiveProviderSpend"] === true
      });
      const runtime = normalizeDebateRuntime({ ...value, role: "judge" }, 0, { participantPath: "judgeConfig" });
      return {
        mode: "model",
        confirmLiveProviderSpend: true,
        ...runtime,
        isLiveJudge: true
      };
    } catch (error) {
      throw toServiceError(error, "debate_judge_config_invalid");
    }
  }

  private parseEvidenceIds(value: unknown): string[] {
    if (value === undefined || value === null) {
      return [];
    }
    if (!Array.isArray(value)) {
      throw new DebateServiceError("invalid_input", "evidenceIds must be an array", [
        { path: "evidenceIds", issue: "must be an array of evidence ids" }
      ]);
    }
    if (value.length > 10) {
      throw new DebateServiceError("invalid_input", "evidenceIds exceeds max length", [
        { path: "evidenceIds", issue: "must contain at most 10 ids" }
      ]);
    }
    const ids: string[] = [];
    for (const entry of value) {
      if (typeof entry !== "string" || entry.length === 0) {
        throw new DebateServiceError("invalid_input", "evidenceIds must contain non-empty strings", [
          { path: "evidenceIds", issue: "every entry must be a non-empty string" }
        ]);
      }
      ids.push(entry);
    }
    return ids;
  }

  private parseLimits(value: unknown): Debate["limits"] {
    if (value === undefined || value === null) {
      return { ...DEFAULT_LIMITS };
    }
    if (!isRecord(value)) {
      throw new DebateServiceError("invalid_input", "limits must be an object", [
        { path: "limits", issue: "must be an object" }
      ]);
    }

    const limits: Debate["limits"] = {
      ...DEFAULT_LIMITS,
      ...value
    };

    assertIntRange("limits.maxRounds", limits.maxRounds, 1, 3);
    assertIntRange("limits.maxTurnsPerAgent", limits.maxTurnsPerAgent, 1, 3);
    assertIntRange("limits.maxTotalMessages", limits.maxTotalMessages, 1, 12);
    assertIntRange("limits.maxDurationSeconds", limits.maxDurationSeconds, 1, 60);

    if (!Number.isFinite(limits.maxCostUsd) || limits.maxCostUsd !== 0) {
      throw new DebateServiceError("invalid_input", "limits.maxCostUsd must be 0 in R9", [
        { path: "limits.maxCostUsd", issue: "must be exactly 0" }
      ]);
    }
    if (!Number.isFinite(limits.maxSearchesPerAgent) || limits.maxSearchesPerAgent !== 0) {
      throw new DebateServiceError("invalid_input", "limits.maxSearchesPerAgent must be 0 in R9", [
        { path: "limits.maxSearchesPerAgent", issue: "must be exactly 0" }
      ]);
    }
    if (limits.humanStopAllowed !== false) {
      throw new DebateServiceError("invalid_input", "limits.humanStopAllowed must be false in R9", [
        { path: "limits.humanStopAllowed", issue: "must be false" }
      ]);
    }

    assertBoolean("limits.requireCitations", limits.requireCitations);
    assertBoolean("limits.requireDisagreementSummary", limits.requireDisagreementSummary);
    assertBoolean("limits.stopOnConsensus", limits.stopOnConsensus);
    assertBoolean("limits.stopOnLowNewInformation", limits.stopOnLowNewInformation);

    return limits;
  }

  private async preauthorizeEvidenceReferences(evidenceIds: string[], options: DebateCreateOptions): Promise<void> {
    if (!options.auth) {
      return;
    }
    const authorizeEvidence = this.deps.hosted?.authorizeEvidence;
    if (!authorizeEvidence) {
      throw new DebateServiceError("tenant_access_denied", "Hosted evidence authorization is unavailable");
    }
    for (const evidenceId of evidenceIds) {
      try {
        const result = await authorizeEvidence({
          evidenceId,
          auth: options.auth,
          ...(options.requestId ? { requestId: options.requestId } : {})
        });
        if (result && result.ok === false) {
          throw new Error("evidence authorization denied");
        }
      } catch {
        this.deps.logger?.warn("debate.create.denied", {
          reasonCode: "debate_evidence_not_found_or_denied",
          requestId: options.requestId
        });
        throw new DebateServiceError(
          "debate_evidence_not_found_or_denied",
          "Evidence was not found or is not available to this caller"
        );
      }
    }
  }

  private async validateEvidenceReferences(evidenceIds: string[], options: DebateCreateOptions): Promise<void> {
    for (const evidenceId of evidenceIds) {
      const record = await this.deps.evidence.get(evidenceId);
      if (!record) {
        if (options.auth) {
          throw new DebateServiceError(
            "debate_evidence_not_found_or_denied",
            "Evidence was not found or is not available to this caller"
          );
        }
        throw new DebateServiceError("evidence_not_found", `Evidence not found: ${evidenceId}`);
      }
      if (record.debateId && record.debateId.startsWith("debate_")) {
        throw new DebateServiceError("invalid_input", "evidence is already bound to another debate", [
          { path: "evidenceIds", issue: `evidence ${evidenceId} belongs to ${record.debateId}` }
        ]);
      }
    }
  }

  private async createParticipantRuns(debate: Debate, evidence: EvidenceItem[]): Promise<void> {
    debate.status = "context_building";
    debate.updatedAt = new Date().toISOString();
    await this.deps.debates.update(debate);

    for (const participant of debate.participants) {
      const context = await this.deps.contextBuilder.build({
        target: "participant",
        sections: [
          {
            name: "debate",
            content: `Topic: ${debate.topic}\nRole: ${participant.role}`
          }
        ],
        evidenceIds: evidence.map((item) => item.id)
      });

      const run = await this.deps.runService.createRun({
        runtime: FAKE_RUNTIME.runtime,
        provider: FAKE_RUNTIME.provider,
        model: FAKE_RUNTIME.model,
        adapterType: FAKE_RUNTIME.adapterType,
        runtimeMode: FAKE_RUNTIME.runtimeMode,
        cwd: this.deps.defaultCwd,
        task: buildParticipantSeedTask(debate.topic, participant.role, participant.id),
        placement: "local",
        approvalPolicy: "default",
        timeoutSeconds: Math.min(60, debate.limits.maxDurationSeconds),
        metadata: {
          debateId: debate.id,
          participantId: participant.id,
          participantRole: participant.role,
          debateTopic: debate.topic,
          debateRunKind: "participant_seed",
          originalTask: buildParticipantSeedTask(debate.topic, participant.role, participant.id),
          contextPacket: context.context
        }
      });
      const completed = await this.deps.runService.startRun(run.id);
      if (completed.status !== "completed") {
        participant.status = runStatusToParticipantStatus(completed.status);
        throw new DebateServiceError("internal_error", `Participant run did not complete: ${completed.status}`);
      }
      participant.runId = completed.id;
      participant.runIds.push(completed.id);
      participant.status = "completed";
      debate.updatedAt = new Date().toISOString();
      await this.deps.debates.update(debate);
    }
  }

  private async executeRounds(debate: Debate, startedAt: number): Promise<void> {
    let round = 1;
    while (true) {
      const stopBeforeRound = determineStopReason(debate, round, startedAt);
      if (stopBeforeRound) {
        debate.stopReason = stopBeforeRound;
        break;
      }

      const phase = round === 1 ? "arguing" : "rebuttal";
      debate.status = phase;
      const roundStartedEvent = await this.appendDebateEvent(debate, "debate.round.started", {
        round,
        phase,
        limitsSnapshot: debate.limits
      });
      debate.eventIds.push(roundStartedEvent.id);
      debate.updatedAt = new Date().toISOString();
      await this.deps.debates.update(debate);

      for (let index = 0; index < debate.participants.length; index += 1) {
        const stopBeforeTurn = determineStopReason(debate, round, startedAt);
        if (stopBeforeTurn) {
          debate.stopReason = stopBeforeTurn;
          break;
        }
        const participant = debate.participants[index]!;
        const other = debate.participants[(index + 1) % debate.participants.length]!;
        if (!participant.runId || !other.runId) {
          throw new DebateServiceError("internal_error", "participant run is missing");
        }

        const previousMessageId = debate.messageIds.length > 0 ? debate.messageIds[debate.messageIds.length - 1] : undefined;
        const content = buildDeterministicTurnContent(debate, participant, round, phase, previousMessageId);
        const routed = await this.deps.messageRouter.createWithEvent({
          debateId: debate.id,
          participantId: participant.id,
          fromRunId: participant.runId,
          toRunId: other.runId,
          channel: `debate:${debate.id}`,
          content,
          attachments: [
            {
              type: "debate_turn",
              debateId: debate.id,
              participantId: participant.id,
              round,
              phase,
              evidenceIds: debate.evidenceIds
            }
          ]
        });

        debate.messageIds.push(routed.message.id);
        debate.eventIds.push(routed.event.id);
        participant.turnsUsed += 1;
        const turnEvent = await this.appendDebateEvent(
          debate,
          round === 1 ? "debate.agent.argument" : "debate.agent.rebuttal",
          {
            round,
            phase,
            participantId: participant.id,
            messageId: routed.message.id
          }
        );
        debate.eventIds.push(turnEvent.id);
        debate.updatedAt = new Date().toISOString();
        await this.deps.debates.update(debate);
      }

      if (debate.stopReason) {
        break;
      }
      round += 1;
    }
  }

  private async finishJudgingAndReport(
    debate: Debate,
    evidence: EvidenceItem[],
    judgeConfig: ParsedCreateInput["judgeConfig"] | undefined = undefined,
    judgeRunId: string | undefined = undefined
  ): Promise<void> {
    debate.status = "judging";
    debate.updatedAt = new Date().toISOString();
    await this.deps.debates.update(debate);

    const messages = await this.loadMessages(debate.messageIds);
    const judge = debate.judge ?? this.judgeRunner.runDeterministic({ debate, messages });
    debate.judge = judge;

    const judgeEvent = await this.appendDebateEvent(debate, "debate.judge.summary", {
      consensus: judge.consensus,
      winner: judge.winner,
      summary: judge.summary,
      disagreementSummary: judge.disagreementSummary,
      stopReason: debate.stopReason
    });
    debate.eventIds.push(judgeEvent.id);

    if (judge.consensus === "consensus_found") {
      const consensusEvent = await this.appendDebateEvent(debate, "debate.consensus", {
        winner: judge.winner,
        summary: judge.summary
      });
      debate.eventIds.push(consensusEvent.id);
    }

    const terminalStatus = judge.consensus === "consensus_found" && debate.limits.stopOnConsensus
      ? "consensus_found"
      : "no_consensus";
    debate.status = terminalStatus;
    debate.completedAt = new Date().toISOString();
    debate.updatedAt = debate.completedAt;

    const artifact = await this.writeFinalReport(debate, evidence, messages);
    if (judgeConfig?.mode === "model" && judgeRunId) {
      artifact.metadata["judgeRunId"] = judgeRunId;
      await this.deps.artifacts.update(artifact);
    }
    debate.finalReportArtifactId = artifact.id;
    debate.finalReportPath = artifact.path;

    await this.deps.debates.update(debate);
  }

  private async writeFinalReport(
    debate: Debate,
    evidence: EvidenceItem[],
    messages: RoutedMessage[],
    options: { allowMetadataFallbackOnWriteFailure?: boolean } = {}
  ): Promise<Artifact> {
    const reportPath = `debates/${debate.id}/final-report.md`;
    const report = renderFinalReport(debate, evidence, messages);
    let storedPath = reportPath;
    let contentStored = false;
    if (this.deps.artifactContent) {
      try {
        storedPath = await this.deps.artifactContent.writeText(reportPath, report);
        contentStored = true;
      } catch (error) {
        if (!options.allowMetadataFallbackOnWriteFailure) {
          throw error;
        }
        storedPath = reportPath;
        contentStored = false;
      }
    }

    const artifact: Artifact = {
      id: `artifact_${crypto.randomUUID()}`,
      debateId: debate.id,
      type: "summary",
      path: storedPath,
      metadata: {
        contentStored,
        kind: "debate_final_report",
        debateId: debate.id,
        stopReason: debate.stopReason,
        messageCount: debate.messageIds.length,
        participantIds: debate.participants.map((participant) => participant.id),
        participantRunIds: debate.participants.flatMap((participant) => participant.runId ? [participant.runId] : []),
        participantRunIdsByTurn: debate.participants.map((participant) => ({
          participantId: participant.id,
          runIds: [...participant.runIds]
        })),
        judgeRunId: (debate as DebateWithRuntimeConfig & { judgeRunId?: string }).judgeRunId,
        evidenceIds: debate.evidenceIds,
        messageIds: debate.messageIds,
        judgeSummary: debate.judge?.summary
      },
      createdAt: new Date().toISOString()
    };
    await this.deps.artifacts.create(artifact);
    const event = await this.appendDebateEvent(debate, "artifact.created", {
      artifactId: artifact.id,
      path: artifact.path,
      type: artifact.type
    });
    debate.eventIds.push(event.id);
    return artifact;
  }

  private async appendDebateEvent(
    debate: Debate,
    type: SwitchyardEvent["type"],
    payload: Record<string, unknown>
  ): Promise<SwitchyardEvent> {
    const existing = await this.deps.events.listByDebate(debate.id);
    const sequence = existing.length === 0
      ? 0
      : existing.reduce((max, event) => (event.sequence > max ? event.sequence : max), -1) + 1;
    const event: SwitchyardEvent = {
      id: `event_${crypto.randomUUID()}`,
      debateId: debate.id,
      type,
      sequence,
      payload,
      createdAt: new Date().toISOString()
    };
    await this.deps.events.append(event);
    if (this.deps.eventBus) {
      try {
        await this.deps.eventBus.publish(event);
      } catch (error) {
        this.deps.logger?.warn("debate.event.publish_failed", {
          debateId: debate.id,
          eventId: event.id,
          reason: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return event;
  }

  private async loadEvidenceRecords(ids: string[]): Promise<EvidenceItem[]> {
    const records: EvidenceItem[] = [];
    for (const id of ids) {
      const item = await this.deps.evidence.get(id);
      if (item) {
        records.push(item);
      }
    }
    return records;
  }

  private async loadMessages(ids: string[]): Promise<RoutedMessage[]> {
    const messages: RoutedMessage[] = [];
    for (const id of ids) {
      const message = await this.deps.messageRouter.get(id);
      if (message) {
        messages.push(message);
      }
    }
    return messages;
  }

  private async requireDebate(id: string): Promise<Debate> {
    const debate = await this.deps.debates.get(id);
    if (!debate) {
      throw new DebateServiceError("debate_not_found", `Debate not found: ${id}`);
    }
    return debate;
  }

  private async markFailed(debate: Debate, error: DebateServiceError): Promise<void> {
    debate.status = "failed";
    debate.stopReason = "failed";
    debate.error = { code: error.code, message: error.message };
    debate.updatedAt = new Date().toISOString();
    debate.completedAt = debate.updatedAt;
    try {
      await this.deps.debates.update(debate);
    } catch {
      // best effort
    }
  }

  private async finalizeFailedDebate(
    debate: Debate,
    evidence: EvidenceItem[],
    error: DebateServiceError
  ): Promise<void> {
    const messages = await this.loadMessages(debate.messageIds);
    debate.status = "failed";
    debate.stopReason = "failed";
    debate.error = { code: error.code, message: error.message };
    debate.judge = buildFailureJudge(debate, messages, error);
    debate.completedAt = new Date().toISOString();
    debate.updatedAt = debate.completedAt;

    try {
      const judgeEvent = await this.appendDebateEvent(debate, "debate.judge.summary", {
        status: "failed",
        consensus: debate.judge.consensus,
        winner: debate.judge.winner,
        summary: debate.judge.summary,
        disagreementSummary: debate.judge.disagreementSummary,
        stopReason: debate.stopReason,
        error: debate.error
      });
      debate.eventIds.push(judgeEvent.id);
    } catch (eventError) {
      this.deps.logger?.warn("debate.failure_judge_event_failed", {
        debateId: debate.id,
        reason: eventError instanceof Error ? eventError.message : String(eventError)
      });
    }

    try {
      const artifact = await this.writeFinalReport(
        debate,
        evidence,
        messages,
        { allowMetadataFallbackOnWriteFailure: true }
      );
      debate.finalReportArtifactId = artifact.id;
      debate.finalReportPath = artifact.path;
    } catch (artifactError) {
      this.deps.logger?.warn("debate.failure_report_failed", {
        debateId: debate.id,
        reason: artifactError instanceof Error ? artifactError.message : String(artifactError)
      });
    }

    await this.markFailed(debate, error);
  }
}

function assertIntRange(path: string, value: unknown, min: number, max: number): void {
  if (!Number.isInteger(value) || typeof value !== "number" || value < min || value > max) {
    throw new DebateServiceError("invalid_input", `${path} is invalid`, [{ path, issue: `must be an integer between ${min} and ${max}` }]);
  }
}

function assertBoolean(path: string, value: unknown): void {
  if (typeof value !== "boolean") {
    throw new DebateServiceError("invalid_input", `${path} must be boolean`, [{ path, issue: "must be a boolean" }]);
  }
}

function buildParticipantSeedTask(topic: string, role: string, participantId: string): string {
  return `Debate participant seed run.

Topic: ${topic}
Role: ${role}
Participant: ${participantId}

Use the fake deterministic runtime output as the auditable seed for this debate participant.`;
}

function buildParticipantTurnTask(debate: Debate, participant: DebateParticipantRecord, round: number, phase: string): string {
  return `Debate participant turn.

Topic: ${debate.topic}
Role: ${participant.role}
Participant: ${participant.id}
Round: ${round}
Phase: ${phase}

Return the participant turn as runtime.output text.`;
}

function buildJudgeTask(debate: Debate, messages: RoutedMessage[]): string {
  return `Debate judge.

Topic: ${debate.topic}
Messages: ${messages.map((message) => `${message.id}: ${message.content}`).join("\n")}

Return compact JSON with consensus, summary, and disagreementSummary.`;
}

function runStatusToParticipantStatus(status: string): DebateParticipantRecord["status"] {
  if (status === "cancelled") {
    return "cancelled";
  }
  if (status === "failed" || status === "timeout") {
    return "failed";
  }
  return "running";
}

function runStatusToParticipantFailureCode(status: Run["status"]): string {
  if (status === "timeout") {
    return "debate_participant_run_timeout";
  }
  if (status === "waiting_for_approval") {
    return "debate_runtime_approval_expired";
  }
  return "debate_participant_run_failed";
}

function isTerminalRunStatus(status: Run["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "timeout";
}

function nextAttemptAt(): string {
  return new Date(Date.now() + 1000).toISOString();
}

function normalizeCreatedRun(value: Run | { run: Run }): Run {
  return "run" in value ? value.run : value;
}

function nextDebateJob(
  debate: Debate,
  job: DebateExecutionJob
): Pick<Parameters<DebateExecutionStore["enqueue"]>[0], "stage" | "debateRound" | "debatePhase" | "participantIndex"> | undefined {
  const nextParticipant = (job.participantIndex ?? 0) + 1;
  if (nextParticipant < debate.participants.length) {
    return {
      stage: "participant_turn",
      debateRound: job.debateRound,
      debatePhase: job.debatePhase,
      participantIndex: nextParticipant
    };
  }

  const stopReason = determineStopReason(debate, job.debateRound + 1, Date.now());
  if (stopReason) {
    debate.stopReason = stopReason;
    return undefined;
  }
  return {
    stage: "participant_turn",
    debateRound: job.debateRound + 1,
    debatePhase: job.debateRound + 1 === 1 ? "arguing" : "rebuttal",
    participantIndex: 0
  };
}

function quotaFinalizationFor(debate: Debate): DebateQuotaFinalization {
  const reasonCode = debate.error?.code ?? debate.stopReason;
  return {
    debateId: debate.id,
    outcome: debate.status === "failed" ? "failed" : "completed",
    ...(reasonCode ? { reasonCode } : {})
  };
}

function ownershipFieldsFromAuth(auth: AuthContext | undefined): Partial<Pick<
  Parameters<DebateExecutionStore["enqueue"]>[0],
  "accountId" | "tenantId" | "projectId" | "userId" | "apiKeyId"
>> {
  if (!auth) {
    return {};
  }
  return {
    accountId: auth.account.id,
    tenantId: auth.tenant.id,
    projectId: auth.project.id,
    userId: auth.user.id,
    apiKeyId: auth.apiKey.id
  };
}

function determineStopReason(debate: Debate, nextRound: number, startedAtMs: number): Debate["stopReason"] | undefined {
  const elapsedSeconds = Math.floor((Date.now() - startedAtMs) / 1000);
  if (elapsedSeconds >= debate.limits.maxDurationSeconds) {
    return "max_duration_seconds";
  }
  if (debate.budget.spentCostUsd > debate.limits.maxCostUsd) {
    return "max_cost_usd";
  }
  if (debate.messageIds.length >= debate.limits.maxTotalMessages) {
    return "max_total_messages";
  }
  if (debate.participants.some((participant) => participant.turnsUsed >= debate.limits.maxTurnsPerAgent)) {
    return "max_turns_per_agent";
  }
  if (debate.limits.stopOnConsensus && hasConsensus(debate)) {
    return "consensus";
  }
  if (nextRound > debate.limits.maxRounds) {
    return "max_rounds";
  }
  return undefined;
}

function hasConsensus(debate: Debate): boolean {
  const roles = debate.participants.map((participant) => participant.role.toLowerCase());
  return roles.length === 2 && roles[0] === roles[1];
}

function buildDeterministicTurnContent(
  debate: Debate,
  participant: DebateParticipantRecord,
  round: number,
  phase: string,
  previousMessageId: string | undefined
): string {
  const isFirst = debate.participants[0]?.id === participant.id;
  const stance = isFirst
    ? "Fake affirmative position: prove the bounded workflow first."
    : "Fake skeptical position: require visible limits, runs, messages, evidence, and artifacts before promotion.";
  const evidenceLabel = debate.evidenceIds.length > 0 ? debate.evidenceIds.join(",") : "none";
  if (round > 1) {
    return `[round ${round} ${phase}] ${participant.role}: Rebuttal: ${stance} Previous=${previousMessageId ?? "none"}. Topic="${debate.topic}". Evidence=${evidenceLabel}.`;
  }
  return `[round ${round} ${phase}] ${participant.role}: ${stance} Topic="${debate.topic}". Evidence=${evidenceLabel}.`;
}

function buildFailureJudge(
  debate: Debate,
  messages: RoutedMessage[],
  error: DebateServiceError
): NonNullable<Debate["judge"]> {
  return {
    consensus: "no_consensus",
    winner: "none",
    summary: `Debate failed before successful completion: ${error.code}. ${error.message}`,
    disagreementSummary: "Debate ended in failure before deterministic completion.",
    evidenceIds: [...debate.evidenceIds],
    messageIds: messages.map((message) => message.id)
  };
}

function renderFinalReport(debate: Debate, evidence: EvidenceItem[], messages: RoutedMessage[]): string {
  const participantLines = debate.participants.map((participant) =>
    `- ${participant.id} (${participant.role}) run=${participant.runId ?? "none"} turns=${participant.turnsUsed}`);
  const evidenceLines = evidence.length > 0
    ? evidence.map((item) => `- ${item.id} - ${item.title} (${item.reliability})`)
    : ["- none"];
  const messageLines = messages.length > 0
    ? messages.map((message) => {
      const turn = Array.isArray(message.attachments)
        ? message.attachments.find((entry) => entry?.["type"] === "debate_turn")
        : undefined;
      const round = typeof turn?.["round"] === "number" ? turn["round"] : "unknown";
      const participantId = typeof turn?.["participantId"] === "string" ? turn["participantId"] : "unknown";
      return `- ${message.id} round=${round} participant=${participantId}`;
    })
    : ["- none"];

  return `# Debate Report: ${debate.id}

Topic: ${debate.topic}
Status: ${debate.status}
Stop reason: ${debate.stopReason ?? "completed"}
Budget: spent ${debate.budget.spentCostUsd} of ${debate.budget.maxCostUsd} USD

## Participants
${participantLines.join("\n")}

## Evidence
${evidenceLines.join("\n")}

## Messages
${messageLines.join("\n")}

## Judge Summary
${debate.judge?.summary ?? "No judge summary"}

## Disagreement Summary
${debate.judge?.disagreementSummary ?? "No disagreement summary"}
`;
}

function toServiceError(error: unknown, fallbackCode: string): DebateServiceError {
  if (error instanceof DebateServiceError) {
    return error;
  }
  if (error && typeof error === "object") {
    const maybe = error as { code?: unknown; message?: unknown; details?: unknown };
    if (typeof maybe.code === "string" && typeof maybe.message === "string") {
      return new DebateServiceError(maybe.code, maybe.message, Array.isArray(maybe.details) ? maybe.details as ServiceDetail[] : undefined);
    }
  }
  if (error instanceof Error) {
    return new DebateServiceError(fallbackCode, error.message);
  }
  return new DebateServiceError(fallbackCode, String(error));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
