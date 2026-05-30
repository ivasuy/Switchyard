import type { Artifact, Debate, EvidenceItem, RoutedMessage, SwitchyardEvent } from "@switchyard/contracts";
import type { ArtifactStore } from "../ports/artifact-store.js";
import type { DebateStore } from "../ports/debate-store.js";
import type { EventStore } from "../ports/event-store.js";
import type { EvidenceStore } from "../ports/evidence-store.js";
import type { RunStore } from "../ports/run-store.js";
import type { RuntimeLogger } from "../ports/runtime-logger.js";
import type { ContextBuilder } from "./context-builder.js";
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
  }>;
  evidenceIds?: string[];
  limits?: Partial<Debate["limits"]>;
}

export interface DebateServiceDependencies {
  debates: DebateStore;
  runs: RunStore;
  runService: Pick<RunService, "createRun" | "startRun">;
  contextBuilder: Pick<ContextBuilder, "build">;
  messageRouter: Pick<MessageRouter, "createWithEvent" | "get">;
  evidence: EvidenceStore;
  events: EventStore;
  artifacts: ArtifactStore;
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

export class DebateService {
  constructor(private readonly deps: DebateServiceDependencies) {}

  async create(input: unknown, options: { wait?: boolean } = {}): Promise<{
    debate: Debate;
    events?: SwitchyardEvent[];
    finalReportArtifact?: Artifact | null;
  }> {
    const parsed = await this.parseCreateInput(input);
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
        runIds: []
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

    await this.deps.debates.create(debate);
    for (const evidenceId of debate.evidenceIds) {
      const event = await this.appendDebateEvent(debate, "debate.evidence.added", { evidenceId });
      debate.eventIds.push(event.id);
      debate.updatedAt = new Date().toISOString();
      await this.deps.debates.update(debate);
    }

    if (!options.wait) {
      return { debate };
    }

    const executed = await this.execute(debate.id);
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

  async execute(debateId: string): Promise<Debate> {
    const debate = await this.requireDebate(debateId);
    if (isTerminalDebateStatus(debate.status)) {
      return debate;
    }

    const startedAt = Date.now();
    const evidence = await this.loadEvidenceRecords(debate.evidenceIds);

    try {
      await this.createParticipantRuns(debate, evidence);
      await this.executeRounds(debate, startedAt);
      await this.finishJudgingAndReport(debate, evidence);
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

  private async parseCreateInput(input: unknown): Promise<{
    topic: string;
    participants: Array<{
      role: string;
      runtime: string;
      provider: string;
      model: string;
      adapterType: string;
      runtimeMode: string;
    }>;
    evidenceIds: string[];
    limits: Debate["limits"];
  }> {
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

    const evidenceIdsRaw = input["evidenceIds"];
    const evidenceIds = this.parseEvidenceIds(evidenceIdsRaw);
    await this.validateEvidenceReferences(evidenceIds);

    const limits = this.parseLimits(input["limits"]);
    return { topic, participants, evidenceIds, limits };
  }

  private parseParticipant(value: unknown, index: number): {
    role: string;
    runtime: string;
    provider: string;
    model: string;
    adapterType: string;
    runtimeMode: string;
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

    const runtime = normalizeRuntimeField(value["runtime"], FAKE_RUNTIME.runtime);
    const provider = normalizeRuntimeField(value["provider"], FAKE_RUNTIME.provider);
    const model = normalizeRuntimeField(value["model"], FAKE_RUNTIME.model);
    const adapterType = normalizeRuntimeField(value["adapterType"], FAKE_RUNTIME.adapterType);
    const runtimeMode = normalizeRuntimeField(value["runtimeMode"], FAKE_RUNTIME.runtimeMode);

    if (
      runtime !== FAKE_RUNTIME.runtime ||
      provider !== FAKE_RUNTIME.provider ||
      model !== FAKE_RUNTIME.model ||
      adapterType !== FAKE_RUNTIME.adapterType ||
      runtimeMode !== FAKE_RUNTIME.runtimeMode
    ) {
      throw new DebateServiceError("invalid_input", "Only fake deterministic participants are supported", [
        { path: `participants.${index}`, issue: "runtime/provider/model/adapterType/runtimeMode must match fake.deterministic defaults" }
      ]);
    }

    return { role, runtime, provider, model, adapterType, runtimeMode };
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

  private async validateEvidenceReferences(evidenceIds: string[]): Promise<void> {
    for (const evidenceId of evidenceIds) {
      const record = await this.deps.evidence.get(evidenceId);
      if (!record) {
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

  private async finishJudgingAndReport(debate: Debate, evidence: EvidenceItem[]): Promise<void> {
    debate.status = "judging";
    debate.updatedAt = new Date().toISOString();
    await this.deps.debates.update(debate);

    const messages = await this.loadMessages(debate.messageIds);
    const judge = judgeDebate(debate, messages);
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
        stopReason: debate.stopReason,
        messageCount: debate.messageIds.length,
        participantRunIds: debate.participants.flatMap((participant) => participant.runId ? [participant.runId] : []),
        evidenceIds: debate.evidenceIds
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

function normalizeRuntimeField(value: unknown, fallback: string): string {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DebateServiceError("invalid_input", "participant runtime field must be a non-empty string");
  }
  return value.trim();
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

function runStatusToParticipantStatus(status: string): DebateParticipantRecord["status"] {
  if (status === "cancelled") {
    return "cancelled";
  }
  if (status === "failed" || status === "timeout") {
    return "failed";
  }
  return "running";
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

function judgeDebate(debate: Debate, messages: RoutedMessage[]): NonNullable<Debate["judge"]> {
  const consensus = hasConsensus(debate) ? "consensus_found" : "no_consensus";
  const summary = messages.length === 0
    ? "The fake participants did not produce debate messages before termination."
    : "The fake participants completed bounded deterministic turns and retained disagreement.";
  const disagreementSummary = debate.limits.requireDisagreementSummary
    ? "affirmative favors proving fake debate first; skeptic asks for visible runtime evidence before promotion."
    : "disagreement summary disabled";

  return {
    consensus,
    summary,
    disagreementSummary,
    winner: "none",
    evidenceIds: [...debate.evidenceIds],
    messageIds: [...debate.messageIds]
  };
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

function isTerminalDebateStatus(status: Debate["status"]): boolean {
  return status === "failed" || status === "completed" || status === "no_consensus" || status === "consensus_found";
}
