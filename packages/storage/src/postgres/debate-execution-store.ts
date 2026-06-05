import type { PostgresDatabaseHandle } from "./database.js";

type DebateExecutionStage = string;
type DebateExecutionJobState = "queued" | "claimed" | "completed" | "failed" | "exhausted";

interface DebateExecutionJob {
  id: string;
  debateId: string;
  stage: DebateExecutionStage;
  debateRound: number;
  debatePhase: string;
  participantIndex?: number;
  pendingRunId?: string;
  pendingJudgeRunId?: string;
  pendingChildRunKey?: string;
  state: DebateExecutionJobState;
  attempts: number;
  maxAttempts: number;
  claimedAt?: string;
  leaseUntil?: string;
  nextAttemptAt: string;
  reasonCode?: string;
  accountId?: string;
  tenantId?: string;
  projectId?: string;
  userId?: string;
  apiKeyId?: string;
  createdAt: string;
  updatedAt: string;
}

interface EnqueueDebateExecutionJobInput {
  id?: string;
  debateId: string;
  stage: string;
  debateRound?: number;
  debatePhase?: string;
  participantIndex?: number;
  maxAttempts?: number;
  nextAttemptAt?: string;
  pendingRunId?: string;
  pendingJudgeRunId?: string;
  pendingChildRunKey?: string;
  accountId?: string;
  tenantId?: string;
  projectId?: string;
  userId?: string;
  apiKeyId?: string;
  now?: string;
}

interface ClaimDebateExecutionJobInput {
  now?: string;
  leaseMs?: number;
}

interface ReleaseDebateExecutionJobInput {
  nextAttemptAt?: string;
  reasonCode?: string;
  now?: string;
}

interface FailDebateExecutionJobInput {
  reasonCode: string;
  retryable?: boolean;
  nextAttemptAt?: string;
  now?: string;
}

interface RecoverStaleDebateExecutionClaimsInput {
  now?: string;
}

type LinkPendingRunResult =
  | { ok: true; job: DebateExecutionJob }
  | { ok: false; reason: "not_found" | "link_conflict"; job?: DebateExecutionJob };

interface PendingRunLink {
  jobId: string;
  debateId: string;
  runId: string;
  stage: DebateExecutionStage;
  debateRound: number;
  debatePhase: string;
  participantIndex?: number;
}

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;

interface DebateExecutionJobRow {
  id: string;
  debate_id: string;
  stage: string;
  debate_round: number;
  debate_phase: string;
  participant_index: number | null;
  pending_run_id: string | null;
  pending_judge_run_id: string | null;
  pending_child_run_key: string | null;
  state: string;
  attempts: number;
  max_attempts: number;
  claimed_at: string | null;
  lease_until: string | null;
  next_attempt_at: string;
  reason_code: string | null;
  account_id: string | null;
  tenant_id: string | null;
  project_id: string | null;
  user_id: string | null;
  api_key_id: string | null;
  created_at: string;
  updated_at: string;
}

function nowIso(value?: string): string {
  if (value) {
    return value;
  }
  return new Date().toISOString();
}

function leaseUntil(now: string, leaseMs: number): string {
  return new Date(Date.parse(now) + leaseMs).toISOString();
}

function toJob(row: DebateExecutionJobRow): DebateExecutionJob {
  const job: DebateExecutionJob = {
    id: row.id,
    debateId: row.debate_id,
    stage: row.stage,
    debateRound: Number(row.debate_round),
    debatePhase: row.debate_phase,
    state: row.state as DebateExecutionJob["state"],
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };

  if (row.participant_index !== null) {
    job.participantIndex = Number(row.participant_index);
  }
  if (row.pending_run_id !== null) {
    job.pendingRunId = row.pending_run_id;
  }
  if (row.pending_judge_run_id !== null) {
    job.pendingJudgeRunId = row.pending_judge_run_id;
  }
  if (row.pending_child_run_key !== null) {
    job.pendingChildRunKey = row.pending_child_run_key;
  }
  if (row.claimed_at !== null) {
    job.claimedAt = row.claimed_at;
  }
  if (row.lease_until !== null) {
    job.leaseUntil = row.lease_until;
  }
  if (row.reason_code !== null) {
    job.reasonCode = row.reason_code;
  }
  if (row.account_id !== null) {
    job.accountId = row.account_id;
  }
  if (row.tenant_id !== null) {
    job.tenantId = row.tenant_id;
  }
  if (row.project_id !== null) {
    job.projectId = row.project_id;
  }
  if (row.user_id !== null) {
    job.userId = row.user_id;
  }
  if (row.api_key_id !== null) {
    job.apiKeyId = row.api_key_id;
  }

  return job;
}

function createJob(input: EnqueueDebateExecutionJobInput): DebateExecutionJob {
  const now = nowIso(input.now);
  const job: DebateExecutionJob = {
    id: input.id ?? `debate_job_${crypto.randomUUID().replaceAll("-", "_")}`,
    debateId: input.debateId,
    stage: input.stage,
    debateRound: input.debateRound ?? 0,
    debatePhase: input.debatePhase ?? "created",
    state: "queued",
    attempts: 0,
    maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    nextAttemptAt: input.nextAttemptAt ?? now,
    createdAt: now,
    updatedAt: now
  };
  if (input.participantIndex !== undefined) {
    job.participantIndex = input.participantIndex;
  }
  if (input.pendingRunId !== undefined) {
    job.pendingRunId = input.pendingRunId;
  }
  if (input.pendingJudgeRunId !== undefined) {
    job.pendingJudgeRunId = input.pendingJudgeRunId;
  }
  if (input.pendingChildRunKey !== undefined) {
    job.pendingChildRunKey = input.pendingChildRunKey;
  }
  if (input.accountId !== undefined) {
    job.accountId = input.accountId;
  }
  if (input.tenantId !== undefined) {
    job.tenantId = input.tenantId;
  }
  if (input.projectId !== undefined) {
    job.projectId = input.projectId;
  }
  if (input.userId !== undefined) {
    job.userId = input.userId;
  }
  if (input.apiKeyId !== undefined) {
    job.apiKeyId = input.apiKeyId;
  }
  return job;
}

function isClaimable(job: DebateExecutionJob, now: string): boolean {
  if (job.state !== "queued") {
    return false;
  }
  return Date.parse(job.nextAttemptAt) <= Date.parse(now);
}

function isStaleClaim(job: DebateExecutionJob, now: string): boolean {
  if (job.state !== "claimed") {
    return false;
  }
  if (!job.leaseUntil) {
    return true;
  }
  return Date.parse(job.leaseUntil) <= Date.parse(now);
}

export class PostgresDebateExecutionStore {
  private readonly items = new Map<string, DebateExecutionJob>();

  constructor(private readonly handle?: PostgresDatabaseHandle) {}

  async enqueue(input: EnqueueDebateExecutionJobInput): Promise<DebateExecutionJob> {
    const job = createJob(input);
    if (this.handle) {
      await this.upsert(job);
      return job;
    }
    this.items.set(job.id, job);
    return job;
  }

  async claim(options: ClaimDebateExecutionJobInput = {}): Promise<DebateExecutionJob | undefined> {
    const now = nowIso(options.now);
    const nextLease = leaseUntil(now, options.leaseMs ?? DEFAULT_LEASE_MS);

    if (this.handle) {
      const result = await this.handle.pool.query(
        `WITH candidate AS (
           SELECT id
           FROM debate_execution_jobs
           WHERE state = 'queued'
             AND next_attempt_at <= $1
           ORDER BY next_attempt_at ASC, created_at ASC, id ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE debate_execution_jobs AS jobs
         SET state = 'claimed',
             attempts = jobs.attempts + 1,
             claimed_at = $1,
             lease_until = $2,
             updated_at = $1
         FROM candidate
         WHERE jobs.id = candidate.id
         RETURNING jobs.*`,
        [now, nextLease]
      );
      const row = result.rows[0] as DebateExecutionJobRow | undefined;
      return row ? toJob(row) : undefined;
    }

    const candidate = [...this.items.values()]
      .filter((job) => isClaimable(job, now))
      .sort((left, right) => {
        if (left.nextAttemptAt === right.nextAttemptAt) {
          if (left.createdAt === right.createdAt) {
            return left.id.localeCompare(right.id);
          }
          return left.createdAt.localeCompare(right.createdAt);
        }
        return left.nextAttemptAt.localeCompare(right.nextAttemptAt);
      })
      .at(0);

    if (!candidate) {
      return undefined;
    }

    const claimed: DebateExecutionJob = {
      ...candidate,
      state: "claimed",
      attempts: candidate.attempts + 1,
      claimedAt: now,
      leaseUntil: nextLease,
      updatedAt: now
    };
    this.items.set(claimed.id, claimed);
    return claimed;
  }

  async release(jobId: string, update: ReleaseDebateExecutionJobInput): Promise<void> {
    const now = nowIso(update.now);
    if (this.handle) {
      await this.handle.pool.query(
        `UPDATE debate_execution_jobs
         SET state = 'queued',
             claimed_at = NULL,
             lease_until = NULL,
             next_attempt_at = $2,
             reason_code = $3,
             updated_at = $4
         WHERE id = $1`,
        [jobId, update.nextAttemptAt ?? now, update.reasonCode ?? null, now]
      );
      return;
    }

    const current = this.items.get(jobId);
    if (!current) {
      return;
    }
    const { claimedAt: _claimedAt, leaseUntil: _leaseUntil, reasonCode: _reasonCode, ...rest } = current;
    const released: DebateExecutionJob = {
      ...rest,
      state: "queued",
      nextAttemptAt: update.nextAttemptAt ?? now,
      updatedAt: now
    };
    if (update.reasonCode !== undefined) {
      released.reasonCode = update.reasonCode;
    }
    this.items.set(jobId, released);
  }

  async complete(jobId: string, now?: string): Promise<void> {
    const at = nowIso(now);
    if (this.handle) {
      await this.handle.pool.query(
        `UPDATE debate_execution_jobs
         SET state = 'completed',
             claimed_at = NULL,
             lease_until = NULL,
             updated_at = $2
         WHERE id = $1`,
        [jobId, at]
      );
      return;
    }

    const current = this.items.get(jobId);
    if (!current) {
      return;
    }
    const { claimedAt: _claimedAt, leaseUntil: _leaseUntil, ...rest } = current;
    this.items.set(jobId, {
      ...rest,
      state: "completed",
      updatedAt: at
    });
  }

  async fail(jobId: string, failure: FailDebateExecutionJobInput): Promise<void> {
    const now = nowIso(failure.now);
    if (this.handle) {
      const current = await this.get(jobId);
      if (!current) {
        return;
      }
      const retryable = failure.retryable ?? false;
      const shouldExhaust = retryable && current.attempts >= current.maxAttempts;
      const nextState = retryable && !shouldExhaust ? "queued" : shouldExhaust ? "exhausted" : "failed";
      await this.handle.pool.query(
        `UPDATE debate_execution_jobs
         SET state = $2,
             claimed_at = NULL,
             lease_until = NULL,
             next_attempt_at = $3,
             reason_code = $4,
             updated_at = $5
         WHERE id = $1`,
        [jobId, nextState, failure.nextAttemptAt ?? now, failure.reasonCode, now]
      );
      return;
    }

    const current = this.items.get(jobId);
    if (!current) {
      return;
    }
    const retryable = failure.retryable ?? false;
    const shouldExhaust = retryable && current.attempts >= current.maxAttempts;
    const nextState = retryable && !shouldExhaust ? "queued" : shouldExhaust ? "exhausted" : "failed";
    const { claimedAt: _claimedAt, leaseUntil: _leaseUntil, ...rest } = current;
    this.items.set(jobId, {
      ...rest,
      state: nextState,
      nextAttemptAt: failure.nextAttemptAt ?? now,
      reasonCode: failure.reasonCode,
      updatedAt: now
    });
  }

  async recoverStaleClaims(
    options: RecoverStaleDebateExecutionClaimsInput = {}
  ): Promise<{ recovered: number; exhausted: number; invalid: number }> {
    const now = nowIso(options.now);

    if (this.handle) {
      const staleResult = await this.handle.pool.query(
        `SELECT *
         FROM debate_execution_jobs
         WHERE state = 'claimed'
           AND (lease_until IS NULL OR lease_until <= $1)
         ORDER BY updated_at ASC, id ASC`,
        [now]
      );

      let recovered = 0;
      let exhausted = 0;
      let invalid = 0;

      for (const raw of staleResult.rows as DebateExecutionJobRow[]) {
        const job = toJob(raw);
        if (!job.leaseUntil) {
          invalid += 1;
          await this.handle.pool.query(
            `UPDATE debate_execution_jobs
             SET state = 'failed',
                 claimed_at = NULL,
                 lease_until = NULL,
                 reason_code = 'debate_execution_invalid_claim',
                 updated_at = $2
             WHERE id = $1`,
            [job.id, now]
          );
          continue;
        }

        if (job.attempts >= job.maxAttempts) {
          exhausted += 1;
          await this.handle.pool.query(
            `UPDATE debate_execution_jobs
             SET state = 'exhausted',
                 claimed_at = NULL,
                 lease_until = NULL,
                 reason_code = COALESCE(reason_code, 'debate_execution_attempts_exhausted'),
                 updated_at = $2
             WHERE id = $1`,
            [job.id, now]
          );
          continue;
        }

        recovered += 1;
        await this.handle.pool.query(
          `UPDATE debate_execution_jobs
           SET state = 'queued',
               claimed_at = NULL,
               lease_until = NULL,
               next_attempt_at = $2,
               reason_code = COALESCE(reason_code, 'debate_execution_claim_stale_recovered'),
               updated_at = $2
           WHERE id = $1`,
          [job.id, now]
        );
      }

      return { recovered, exhausted, invalid };
    }

    let recovered = 0;
    let exhausted = 0;
    let invalid = 0;
    for (const job of [...this.items.values()]) {
      if (!isStaleClaim(job, now)) {
        continue;
      }
      if (!job.leaseUntil) {
        invalid += 1;
        const { claimedAt: _claimedAt, leaseUntil: _leaseUntil, ...rest } = job;
        this.items.set(job.id, {
          ...rest,
          state: "failed",
          reasonCode: "debate_execution_invalid_claim",
          updatedAt: now
        });
        continue;
      }
      if (job.attempts >= job.maxAttempts) {
        exhausted += 1;
        const { claimedAt: _claimedAt, leaseUntil: _leaseUntil, ...rest } = job;
        this.items.set(job.id, {
          ...rest,
          state: "exhausted",
          reasonCode: job.reasonCode ?? "debate_execution_attempts_exhausted",
          updatedAt: now
        });
        continue;
      }
      recovered += 1;
      const { claimedAt: _claimedAt, leaseUntil: _leaseUntil, ...rest } = job;
      this.items.set(job.id, {
        ...rest,
        state: "queued",
        nextAttemptAt: now,
        reasonCode: job.reasonCode ?? "debate_execution_claim_stale_recovered",
        updatedAt: now
      });
    }
    return { recovered, exhausted, invalid };
  }

  async get(id: string): Promise<DebateExecutionJob | undefined> {
    if (this.handle) {
      const result = await this.handle.pool.query("SELECT * FROM debate_execution_jobs WHERE id = $1 LIMIT 1", [id]);
      const row = result.rows[0] as DebateExecutionJobRow | undefined;
      return row ? toJob(row) : undefined;
    }
    return this.items.get(id);
  }

  async stats(): Promise<{ queued: number; claimed: number; failed: number; exhausted: number }> {
    if (this.handle) {
      const result = await this.handle.pool.query(
        `SELECT
           SUM(CASE WHEN state = 'queued' THEN 1 ELSE 0 END)::int AS queued,
           SUM(CASE WHEN state = 'claimed' THEN 1 ELSE 0 END)::int AS claimed,
           SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END)::int AS failed,
           SUM(CASE WHEN state = 'exhausted' THEN 1 ELSE 0 END)::int AS exhausted
         FROM debate_execution_jobs`
      );
      const row = result.rows[0] as Record<string, unknown> | undefined;
      return {
        queued: Number(row?.["queued"] ?? 0),
        claimed: Number(row?.["claimed"] ?? 0),
        failed: Number(row?.["failed"] ?? 0),
        exhausted: Number(row?.["exhausted"] ?? 0)
      };
    }

    let queued = 0;
    let claimed = 0;
    let failed = 0;
    let exhausted = 0;
    for (const job of this.items.values()) {
      if (job.state === "queued") queued += 1;
      if (job.state === "claimed") claimed += 1;
      if (job.state === "failed") failed += 1;
      if (job.state === "exhausted") exhausted += 1;
    }
    return { queued, claimed, failed, exhausted };
  }

  async linkPendingRun(
    jobId: string,
    key: string,
    runId: string,
    expectedStage: DebateExecutionStage
  ): Promise<LinkPendingRunResult> {
    const now = nowIso();

    if (this.handle) {
      const result = await this.handle.pool.query(
        `UPDATE debate_execution_jobs
         SET pending_run_id = $2,
             pending_child_run_key = $3,
             updated_at = $4
         WHERE id = $1
           AND stage = $5
           AND (pending_child_run_key IS NULL OR pending_child_run_key = $3)
           AND (pending_run_id IS NULL OR pending_run_id = $2)
         RETURNING *`,
        [jobId, runId, key, now, expectedStage]
      );
      const row = result.rows[0] as DebateExecutionJobRow | undefined;
      if (row) {
        return { ok: true, job: toJob(row) };
      }
      const current = await this.get(jobId);
      if (!current) {
        return { ok: false, reason: "not_found" };
      }
      return { ok: false, reason: "link_conflict", job: current };
    }

    const current = this.items.get(jobId);
    if (!current) {
      return { ok: false, reason: "not_found" };
    }
    if (current.stage !== expectedStage) {
      return { ok: false, reason: "link_conflict", job: current };
    }
    if (current.pendingChildRunKey && current.pendingChildRunKey !== key) {
      return { ok: false, reason: "link_conflict", job: current };
    }
    if (current.pendingRunId && current.pendingRunId !== runId) {
      return { ok: false, reason: "link_conflict", job: current };
    }

    const updated: DebateExecutionJob = {
      ...current,
      pendingChildRunKey: key,
      pendingRunId: runId,
      updatedAt: now
    };
    this.items.set(updated.id, updated);
    return { ok: true, job: updated };
  }

  async findPendingRunByKey(key: string): Promise<PendingRunLink | undefined> {
    if (this.handle) {
      const result = await this.handle.pool.query(
        `SELECT *
         FROM debate_execution_jobs
         WHERE pending_child_run_key = $1
           AND pending_run_id IS NOT NULL
           AND state IN ('queued', 'claimed')
         ORDER BY updated_at DESC, id DESC
         LIMIT 1`,
        [key]
      );
      const row = result.rows[0] as DebateExecutionJobRow | undefined;
      if (!row) {
        return undefined;
      }
      const job = toJob(row);
      return {
        jobId: job.id,
        debateId: job.debateId,
        runId: job.pendingRunId as string,
        stage: job.stage,
        debateRound: job.debateRound,
        debatePhase: job.debatePhase,
        ...(job.participantIndex !== undefined ? { participantIndex: job.participantIndex } : {})
      };
    }

    const match = [...this.items.values()]
      .filter((job) => job.pendingChildRunKey === key && Boolean(job.pendingRunId) && (job.state === "queued" || job.state === "claimed"))
      .sort((left, right) => {
        if (left.updatedAt === right.updatedAt) {
          return right.id.localeCompare(left.id);
        }
        return left.updatedAt > right.updatedAt ? -1 : 1;
      })
      .at(0);

    if (!match || !match.pendingRunId) {
      return undefined;
    }

    return {
      jobId: match.id,
      debateId: match.debateId,
      runId: match.pendingRunId,
      stage: match.stage,
      debateRound: match.debateRound,
      debatePhase: match.debatePhase,
      ...(match.participantIndex !== undefined ? { participantIndex: match.participantIndex } : {})
    };
  }

  private async upsert(job: DebateExecutionJob): Promise<void> {
    await this.handle?.pool.query(
      `INSERT INTO debate_execution_jobs (
        id, debate_id, stage, debate_round, debate_phase, participant_index,
        pending_run_id, pending_judge_run_id, pending_child_run_key, state,
        attempts, max_attempts, claimed_at, lease_until, next_attempt_at,
        reason_code, account_id, tenant_id, project_id, user_id, api_key_id,
        created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
      ON CONFLICT (id) DO UPDATE SET
        debate_id = EXCLUDED.debate_id,
        stage = EXCLUDED.stage,
        debate_round = EXCLUDED.debate_round,
        debate_phase = EXCLUDED.debate_phase,
        participant_index = EXCLUDED.participant_index,
        pending_run_id = EXCLUDED.pending_run_id,
        pending_judge_run_id = EXCLUDED.pending_judge_run_id,
        pending_child_run_key = EXCLUDED.pending_child_run_key,
        state = EXCLUDED.state,
        attempts = EXCLUDED.attempts,
        max_attempts = EXCLUDED.max_attempts,
        claimed_at = EXCLUDED.claimed_at,
        lease_until = EXCLUDED.lease_until,
        next_attempt_at = EXCLUDED.next_attempt_at,
        reason_code = EXCLUDED.reason_code,
        account_id = EXCLUDED.account_id,
        tenant_id = EXCLUDED.tenant_id,
        project_id = EXCLUDED.project_id,
        user_id = EXCLUDED.user_id,
        api_key_id = EXCLUDED.api_key_id,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at`,
      [
        job.id,
        job.debateId,
        job.stage,
        job.debateRound,
        job.debatePhase,
        job.participantIndex ?? null,
        job.pendingRunId ?? null,
        job.pendingJudgeRunId ?? null,
        job.pendingChildRunKey ?? null,
        job.state,
        job.attempts,
        job.maxAttempts,
        job.claimedAt ?? null,
        job.leaseUntil ?? null,
        job.nextAttemptAt,
        job.reasonCode ?? null,
        job.accountId ?? null,
        job.tenantId ?? null,
        job.projectId ?? null,
        job.userId ?? null,
        job.apiKeyId ?? null,
        job.createdAt,
        job.updatedAt
      ]
    );
  }
}
