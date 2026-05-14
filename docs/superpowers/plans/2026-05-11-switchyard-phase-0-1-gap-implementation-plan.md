# Switchyard Phase 0/1 Gap Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining Phase 0 and Phase 1 gaps before starting Phase 2.

**Architecture:** Keep the core protocol-neutral and move local persistence into a new `@switchyard/storage` package. The daemon wires storage, queue, event bus, REST replay/live events, and fake adapter together while tests can still use in-memory stores from `@switchyard/testkit`.

**Tech Stack:** TypeScript, Fastify, Zod contracts, Vitest, Drizzle ORM, better-sqlite3, Node filesystem APIs, pnpm workspaces, Turborepo.

---

## File Map

- `docs/superpowers/specs/2026-05-11-switchyard-phase-0-1-gap-spec.md`: gap spec for this work.
- `packages/core/src/services/*.ts`: split service shell exports into explicit files while keeping `shells.ts` compatibility.
- `packages/core/test/runtime-adapter-contract.test.ts`: reusable adapter contract coverage.
- `packages/core/src/services/runtime-runner-service.ts`: collect adapter artifacts and publish stored events to `EventBus`.
- `packages/core/src/services/run-launcher-service.ts`: local asynchronous run launcher.
- `packages/storage/*`: local SQLite repositories and filesystem artifact store.
- `packages/protocol-rest/src/run-routes.ts`: async run creation, artifact endpoint, and REST wiring for SSE.
- `packages/protocol-sse/src/sse-stream.ts`: replay plus live SSE formatting and event collection helper.
- `apps/daemon/src/config.ts`: add data and artifact path config.
- `apps/daemon/src/app.ts`: wire storage-backed daemon.
- `apps/daemon/test/smoke.test.ts`: cover persistence and artifacts.
- `README.md`, `CHANGELOG.md`, `docs/superpowers/plans/2026-05-11-switchyard-master-implementation-plan.md`: update implementation status.

## Task 1: Close Phase 0 Service Shell and Adapter Contract Gaps

**Files:**
- Create: `packages/core/src/services/approval-service.ts`
- Create: `packages/core/src/services/artifact-service.ts`
- Create: `packages/core/src/services/context-builder.ts`
- Create: `packages/core/src/services/debate-service.ts`
- Create: `packages/core/src/services/event-service.ts`
- Create: `packages/core/src/services/evidence-service.ts`
- Create: `packages/core/src/services/memory-service.ts`
- Create: `packages/core/src/services/message-router.ts`
- Create: `packages/core/src/services/placement-service.ts`
- Create: `packages/core/src/services/registry-service.ts`
- Create: `packages/core/src/services/session-service.ts`
- Create: `packages/core/src/services/tool-router.ts`
- Modify: `packages/core/src/services/shells.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/runtime-adapter-contract.test.ts`

- [ ] **Step 1: Create explicit service shell files**

Create `packages/core/src/services/approval-service.ts`:

```ts
import { createNotImplementedError } from "../errors.js";

export class ApprovalService {
  protected notImplemented(method: string): never {
    throw createNotImplementedError("approval-service", method);
  }
}
```

Create `packages/core/src/services/artifact-service.ts`:

```ts
import { createNotImplementedError } from "../errors.js";

export class ArtifactService {
  protected notImplemented(method: string): never {
    throw createNotImplementedError("artifact-service", method);
  }
}
```

Create `packages/core/src/services/context-builder.ts`:

```ts
import { createNotImplementedError } from "../errors.js";

export class ContextBuilder {
  protected notImplemented(method: string): never {
    throw createNotImplementedError("context-builder", method);
  }
}
```

Create `packages/core/src/services/debate-service.ts`:

```ts
import { createNotImplementedError } from "../errors.js";

export class DebateService {
  protected notImplemented(method: string): never {
    throw createNotImplementedError("debate-service", method);
  }
}
```

Create `packages/core/src/services/event-service.ts`:

```ts
import { createNotImplementedError } from "../errors.js";

export class EventService {
  protected notImplemented(method: string): never {
    throw createNotImplementedError("event-service", method);
  }
}
```

Create `packages/core/src/services/evidence-service.ts`:

```ts
import { createNotImplementedError } from "../errors.js";

export class EvidenceService {
  protected notImplemented(method: string): never {
    throw createNotImplementedError("evidence-service", method);
  }
}
```

Create `packages/core/src/services/memory-service.ts`:

```ts
import { createNotImplementedError } from "../errors.js";

export class MemoryService {
  protected notImplemented(method: string): never {
    throw createNotImplementedError("memory-service", method);
  }
}
```

Create `packages/core/src/services/message-router.ts`:

```ts
import { createNotImplementedError } from "../errors.js";

export class MessageRouter {
  protected notImplemented(method: string): never {
    throw createNotImplementedError("message-router", method);
  }
}
```

Create `packages/core/src/services/placement-service.ts`:

```ts
import { createNotImplementedError } from "../errors.js";

export class PlacementService {
  protected notImplemented(method: string): never {
    throw createNotImplementedError("placement-service", method);
  }
}
```

Create `packages/core/src/services/registry-service.ts`:

```ts
import { createNotImplementedError } from "../errors.js";

export class RegistryService {
  protected notImplemented(method: string): never {
    throw createNotImplementedError("registry-service", method);
  }
}
```

Create `packages/core/src/services/session-service.ts`:

```ts
import { createNotImplementedError } from "../errors.js";

export class SessionService {
  protected notImplemented(method: string): never {
    throw createNotImplementedError("session-service", method);
  }
}
```

Create `packages/core/src/services/tool-router.ts`:

```ts
import { createNotImplementedError } from "../errors.js";

export class ToolRouter {
  protected notImplemented(method: string): never {
    throw createNotImplementedError("tool-router", method);
  }
}
```

- [ ] **Step 2: Replace `shells.ts` with compatibility re-exports**

```ts
export * from "./approval-service.js";
export * from "./artifact-service.js";
export * from "./context-builder.js";
export * from "./debate-service.js";
export * from "./event-service.js";
export * from "./evidence-service.js";
export * from "./memory-service.js";
export * from "./message-router.js";
export * from "./placement-service.js";
export * from "./registry-service.js";
export * from "./session-service.js";
export * from "./tool-router.js";
```

- [ ] **Step 3: Export explicit service files from `index.ts`**

Add these lines after the existing service exports:

```ts
export * from "./services/approval-service.js";
export * from "./services/artifact-service.js";
export * from "./services/context-builder.js";
export * from "./services/debate-service.js";
export * from "./services/event-service.js";
export * from "./services/evidence-service.js";
export * from "./services/memory-service.js";
export * from "./services/message-router.js";
export * from "./services/placement-service.js";
export * from "./services/registry-service.js";
export * from "./services/session-service.js";
export * from "./services/tool-router.js";
```

- [ ] **Step 4: Add adapter contract test**

Create `packages/core/test/runtime-adapter-contract.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FakeRuntimeAdapter } from "@switchyard/testkit";

describe("runtime adapter contract", () => {
  it("supports check, start, events, send, cancel, tools, and artifacts", async () => {
    const adapter = new FakeRuntimeAdapter();
    const check = await adapter.check({});
    const session = await adapter.start({
      runId: "run_contract",
      runtime: "fake",
      provider: "test",
      model: "test-model",
      cwd: "/repo",
      task: "contract test",
      metadata: {}
    });
    const events = [];

    for await (const event of adapter.events({ ...session, runId: "run_contract" })) {
      events.push(event);
    }

    await adapter.send({ ...session, runId: "run_contract" }, { text: "continue" });
    await adapter.cancel({ ...session, runId: "run_contract" });

    expect(check.ok).toBe(true);
    expect(session.sessionId).toMatch(/^session_/);
    expect(events.map((event) => event.type)).toEqual(["runtime.status", "runtime.output", "run.completed"]);
    expect(await adapter.tools({ ...session, runId: "run_contract" })).toEqual(["fake.echo"]);
    expect((await adapter.artifacts({ ...session, runId: "run_contract" }))[0]).toMatchObject({
      type: "transcript"
    });
  });
});
```

- [ ] **Step 5: Run Phase 0 tests**

Run: `pnpm --filter @switchyard/core test`

Expected: all core tests pass, including `runtime-adapter-contract.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "test: close phase 0 adapter contract gaps"
```

## Task 2: Add Local Storage Package Skeleton

**Files:**
- Create: `packages/storage/package.json`
- Create: `packages/storage/tsconfig.json`
- Create: `packages/storage/src/index.ts`
- Create: `packages/storage/src/sqlite/schema.ts`
- Create: `packages/storage/src/sqlite/database.ts`

- [ ] **Step 1: Add package manifest**

Create `packages/storage/package.json`:

```json
{
  "name": "@switchyard/storage",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "lint": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@switchyard/contracts": "workspace:*",
    "@switchyard/core": "workspace:*",
    "better-sqlite3": "^12.5.0",
    "drizzle-orm": "^0.45.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "typescript": "^5.9.3",
    "vitest": "^4.1.5"
  }
}
```

- [ ] **Step 2: Add package tsconfig**

Create `packages/storage/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Add SQLite schema**

Create `packages/storage/src/sqlite/schema.ts`:

```ts
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  runtime: text("runtime").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  adapterType: text("adapter_type").notNull(),
  cwd: text("cwd").notNull(),
  task: text("task").notNull(),
  status: text("status").notNull(),
  placement: text("placement").notNull(),
  approvalPolicy: text("approval_policy").notNull(),
  timeoutSeconds: integer("timeout_seconds").notNull(),
  metadataJson: text("metadata_json").notNull(),
  createdAt: text("created_at").notNull(),
  startedAt: text("started_at"),
  endedAt: text("ended_at")
});

export const runEvents = sqliteTable("run_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  runId: text("run_id").notNull(),
  debateId: text("debate_id"),
  participantId: text("participant_id"),
  provider: text("provider"),
  model: text("model"),
  sequence: integer("sequence").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: text("created_at").notNull()
});

export const runtimeSessions = sqliteTable("runtime_sessions", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  runtime: text("runtime").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  protocol: text("protocol").notNull(),
  status: text("status").notNull(),
  externalSessionKey: text("external_session_key"),
  processId: integer("process_id"),
  stateJson: text("state_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at")
});

export const artifacts = sqliteTable("artifacts", {
  id: text("id").primaryKey(),
  runId: text("run_id"),
  debateId: text("debate_id"),
  provider: text("provider"),
  model: text("model"),
  type: text("type").notNull(),
  path: text("path").notNull(),
  metadataJson: text("metadata_json").notNull(),
  createdAt: text("created_at").notNull()
});
```

- [ ] **Step 4: Add database opener and migration**

Create `packages/storage/src/sqlite/database.ts`:

```ts
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export type SwitchyardSqliteDatabase = BetterSQLite3Database<typeof schema>;

export interface OpenSqliteStorageResult {
  sqlite: Database.Database;
  db: SwitchyardSqliteDatabase;
}

export function openSqliteStorage(path: string): OpenSqliteStorageResult {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  migrate(sqlite);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function migrate(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      runtime TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      adapter_type TEXT NOT NULL,
      cwd TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL,
      placement TEXT NOT NULL,
      approval_policy TEXT NOT NULL,
      timeout_seconds INTEGER NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT
    );
    CREATE TABLE IF NOT EXISTS run_events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      run_id TEXT NOT NULL,
      debate_id TEXT,
      participant_id TEXT,
      provider TEXT,
      model TEXT,
      sequence INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS run_events_run_sequence_idx ON run_events(run_id, sequence);
    CREATE TABLE IF NOT EXISTS runtime_sessions (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      runtime TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      protocol TEXT NOT NULL,
      status TEXT NOT NULL,
      external_session_key TEXT,
      process_id INTEGER,
      state_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS runtime_sessions_run_id_idx ON runtime_sessions(run_id);
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      debate_id TEXT,
      provider TEXT,
      model TEXT,
      type TEXT NOT NULL,
      path TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS artifacts_run_id_idx ON artifacts(run_id);
  `);
}
```

- [ ] **Step 5: Export package API**

Create `packages/storage/src/index.ts`:

```ts
export * from "./sqlite/database.js";
```

- [ ] **Step 6: Install dependencies**

Run: `pnpm install`

Expected: lockfile updates with `drizzle-orm`, `better-sqlite3`, and `@types/better-sqlite3`.

- [ ] **Step 7: Run storage typecheck**

Run: `pnpm --filter @switchyard/storage typecheck`

Expected: passes.

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml packages/storage
git commit -m "feat: add local sqlite storage package"
```

## Task 3: Implement SQLite Stores

**Files:**
- Create: `packages/storage/src/sqlite/run-store.ts`
- Create: `packages/storage/src/sqlite/event-store.ts`
- Create: `packages/storage/src/sqlite/session-store.ts`
- Create: `packages/storage/src/sqlite/artifact-store.ts`
- Modify: `packages/storage/src/index.ts`
- Create: `packages/storage/test/sqlite-storage.test.ts`

- [ ] **Step 1: Write persistence tests**

Create `packages/storage/test/sqlite-storage.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  openSqliteStorage,
  SqliteArtifactStore,
  SqliteEventStore,
  SqliteRunStore,
  SqliteSessionStore
} from "../src/index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("sqlite storage", () => {
  it("persists runs, events, sessions, and artifacts across re-open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "switchyard-storage-"));
    dirs.push(dir);
    const dbPath = join(dir, "switchyard.sqlite");
    const first = openSqliteStorage(dbPath);
    const runs = new SqliteRunStore(first.db);
    const events = new SqliteEventStore(first.db);
    const sessions = new SqliteSessionStore(first.db);
    const artifacts = new SqliteArtifactStore(first.db);

    await runs.create({
      id: "run_storage",
      runtime: "fake",
      provider: "test",
      model: "test-model",
      adapterType: "process",
      cwd: "/repo",
      task: "persist",
      status: "queued",
      placement: "local",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: { source: "test" },
      createdAt: "2026-05-11T00:00:00.000Z"
    });
    await events.append({
      id: "event_storage",
      type: "run.queued",
      runId: "run_storage",
      sequence: 0,
      payload: { ok: true },
      createdAt: "2026-05-11T00:00:00.000Z"
    });
    await sessions.create({
      id: "session_storage",
      runId: "run_storage",
      runtime: "fake",
      provider: "test",
      model: "test-model",
      protocol: "process",
      status: "active",
      state: { cursor: 1 },
      createdAt: "2026-05-11T00:00:00.000Z"
    });
    await artifacts.create({
      id: "artifact_storage",
      runId: "run_storage",
      type: "transcript",
      path: "runs/run_storage/transcript.jsonl",
      metadata: { bytes: 12 },
      createdAt: "2026-05-11T00:00:00.000Z"
    });
    first.sqlite.close();

    const second = openSqliteStorage(dbPath);
    expect(await new SqliteRunStore(second.db).get("run_storage")).toMatchObject({ metadata: { source: "test" } });
    expect(await new SqliteEventStore(second.db).listByRun("run_storage")).toHaveLength(1);
    expect(await new SqliteSessionStore(second.db).getByRunId("run_storage")).toMatchObject({ state: { cursor: 1 } });
    expect(await new SqliteArtifactStore(second.db).listByRun("run_storage")).toHaveLength(1);
    second.sqlite.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @switchyard/storage test`

Expected: fails because `SqliteRunStore`, `SqliteEventStore`, `SqliteSessionStore`, and `SqliteArtifactStore` are not defined.

- [ ] **Step 3: Implement SQLite stores**

Create `packages/storage/src/sqlite/run-store.ts`:

```ts
import type { Run } from "@switchyard/contracts";
import type { RunStore } from "@switchyard/core";
import { eq } from "drizzle-orm";
import type { SwitchyardSqliteDatabase } from "./database.js";
import { runs } from "./schema.js";

export class SqliteRunStore implements RunStore {
  constructor(private readonly db: SwitchyardSqliteDatabase) {}

  async create(run: Run): Promise<Run> {
    this.db.insert(runs).values(toRow(run)).run();
    return run;
  }

  async get(id: string): Promise<Run | undefined> {
    const row = this.db.select().from(runs).where(eq(runs.id, id)).get();
    return row ? fromRow(row) : undefined;
  }

  async update(run: Run): Promise<Run> {
    this.db.update(runs).set(toRow(run)).where(eq(runs.id, run.id)).run();
    return run;
  }
}

function toRow(run: Run) {
  return {
    id: run.id,
    runtime: run.runtime,
    provider: run.provider,
    model: run.model,
    adapterType: run.adapterType,
    cwd: run.cwd,
    task: run.task,
    status: run.status,
    placement: run.placement,
    approvalPolicy: run.approvalPolicy,
    timeoutSeconds: run.timeoutSeconds,
    metadataJson: JSON.stringify(run.metadata),
    createdAt: run.createdAt,
    startedAt: run.startedAt ?? null,
    endedAt: run.endedAt ?? null
  };
}

function fromRow(row: typeof runs.$inferSelect): Run {
  return {
    id: row.id,
    runtime: row.runtime,
    provider: row.provider,
    model: row.model,
    adapterType: row.adapterType as Run["adapterType"],
    cwd: row.cwd,
    task: row.task,
    status: row.status as Run["status"],
    placement: row.placement as Run["placement"],
    approvalPolicy: row.approvalPolicy,
    timeoutSeconds: row.timeoutSeconds,
    metadata: JSON.parse(row.metadataJson) as Record<string, unknown>,
    createdAt: row.createdAt,
    ...(row.startedAt ? { startedAt: row.startedAt } : {}),
    ...(row.endedAt ? { endedAt: row.endedAt } : {})
  };
}
```

Create `packages/storage/src/sqlite/event-store.ts`:

```ts
import type { SwitchyardEvent } from "@switchyard/contracts";
import type { EventStore } from "@switchyard/core";
import { asc, eq } from "drizzle-orm";
import type { SwitchyardSqliteDatabase } from "./database.js";
import { runEvents } from "./schema.js";

export class SqliteEventStore implements EventStore {
  constructor(private readonly db: SwitchyardSqliteDatabase) {}

  async append(event: SwitchyardEvent): Promise<SwitchyardEvent> {
    this.db.insert(runEvents).values(toRow(event)).run();
    return event;
  }

  async listByRun(runId: string): Promise<SwitchyardEvent[]> {
    return this.db.select()
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(asc(runEvents.sequence))
      .all()
      .map(fromRow);
  }
}

function toRow(event: SwitchyardEvent) {
  return {
    id: event.id,
    type: event.type,
    runId: event.runId ?? "",
    debateId: event.debateId ?? null,
    participantId: event.participantId ?? null,
    provider: event.provider ?? null,
    model: event.model ?? null,
    sequence: event.sequence,
    payloadJson: JSON.stringify(event.payload),
    createdAt: event.createdAt
  };
}

function fromRow(row: typeof runEvents.$inferSelect): SwitchyardEvent {
  return {
    id: row.id,
    type: row.type as SwitchyardEvent["type"],
    runId: row.runId,
    sequence: row.sequence,
    payload: JSON.parse(row.payloadJson) as Record<string, unknown>,
    createdAt: row.createdAt,
    ...(row.debateId ? { debateId: row.debateId } : {}),
    ...(row.participantId ? { participantId: row.participantId } : {}),
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.model ? { model: row.model } : {})
  };
}
```

Create `packages/storage/src/sqlite/session-store.ts`:

```ts
import type { RuntimeSession } from "@switchyard/contracts";
import type { SessionStore } from "@switchyard/core";
import { eq } from "drizzle-orm";
import type { SwitchyardSqliteDatabase } from "./database.js";
import { runtimeSessions } from "./schema.js";

export class SqliteSessionStore implements SessionStore {
  constructor(private readonly db: SwitchyardSqliteDatabase) {}

  async create(session: RuntimeSession): Promise<RuntimeSession> {
    this.db.insert(runtimeSessions).values(toRow(session)).run();
    return session;
  }

  async get(id: string): Promise<RuntimeSession | undefined> {
    const row = this.db.select().from(runtimeSessions).where(eq(runtimeSessions.id, id)).get();
    return row ? fromRow(row) : undefined;
  }

  async getByRunId(runId: string): Promise<RuntimeSession | undefined> {
    const row = this.db.select().from(runtimeSessions).where(eq(runtimeSessions.runId, runId)).get();
    return row ? fromRow(row) : undefined;
  }

  async update(session: RuntimeSession): Promise<RuntimeSession> {
    this.db.update(runtimeSessions).set(toRow(session)).where(eq(runtimeSessions.id, session.id)).run();
    return session;
  }
}

function toRow(session: RuntimeSession) {
  return {
    id: session.id,
    runId: session.runId,
    runtime: session.runtime,
    provider: session.provider,
    model: session.model,
    protocol: session.protocol,
    status: session.status,
    externalSessionKey: session.externalSessionKey ?? null,
    processId: session.processId ?? null,
    stateJson: JSON.stringify(session.state),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt ?? null
  };
}

function fromRow(row: typeof runtimeSessions.$inferSelect): RuntimeSession {
  return {
    id: row.id,
    runId: row.runId,
    runtime: row.runtime,
    provider: row.provider,
    model: row.model,
    protocol: row.protocol as RuntimeSession["protocol"],
    status: row.status as RuntimeSession["status"],
    state: JSON.parse(row.stateJson) as Record<string, unknown>,
    createdAt: row.createdAt,
    ...(row.externalSessionKey ? { externalSessionKey: row.externalSessionKey } : {}),
    ...(row.processId ? { processId: row.processId } : {}),
    ...(row.updatedAt ? { updatedAt: row.updatedAt } : {})
  };
}
```

Create `packages/storage/src/sqlite/artifact-store.ts`:

```ts
import type { Artifact } from "@switchyard/contracts";
import type { ArtifactStore } from "@switchyard/core";
import { eq } from "drizzle-orm";
import type { SwitchyardSqliteDatabase } from "./database.js";
import { artifacts } from "./schema.js";

export class SqliteArtifactStore implements ArtifactStore {
  constructor(private readonly db: SwitchyardSqliteDatabase) {}

  async create(artifact: Artifact): Promise<Artifact> {
    this.db.insert(artifacts).values(toRow(artifact)).run();
    return artifact;
  }

  async get(id: string): Promise<Artifact | undefined> {
    const row = this.db.select().from(artifacts).where(eq(artifacts.id, id)).get();
    return row ? fromRow(row) : undefined;
  }

  async update(artifact: Artifact): Promise<Artifact> {
    this.db.update(artifacts).set(toRow(artifact)).where(eq(artifacts.id, artifact.id)).run();
    return artifact;
  }

  async listByRun(runId: string): Promise<Artifact[]> {
    return this.db.select().from(artifacts).where(eq(artifacts.runId, runId)).all().map(fromRow);
  }
}

function toRow(artifact: Artifact) {
  return {
    id: artifact.id,
    runId: artifact.runId ?? null,
    debateId: artifact.debateId ?? null,
    provider: artifact.provider ?? null,
    model: artifact.model ?? null,
    type: artifact.type,
    path: artifact.path,
    metadataJson: JSON.stringify(artifact.metadata),
    createdAt: artifact.createdAt
  };
}

function fromRow(row: typeof artifacts.$inferSelect): Artifact {
  return {
    id: row.id,
    type: row.type as Artifact["type"],
    path: row.path,
    metadata: JSON.parse(row.metadataJson) as Record<string, unknown>,
    createdAt: row.createdAt,
    ...(row.runId ? { runId: row.runId } : {}),
    ...(row.debateId ? { debateId: row.debateId } : {}),
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.model ? { model: row.model } : {})
  };
}
```
  }
}
```

- [ ] **Step 4: Export stores**

Update `packages/storage/src/index.ts`:

```ts
export * from "./sqlite/artifact-store.js";
export * from "./sqlite/database.js";
export * from "./sqlite/event-store.js";
export * from "./sqlite/run-store.js";
export * from "./sqlite/session-store.js";
```

- [ ] **Step 5: Run storage tests**

Run: `pnpm --filter @switchyard/storage test`

Expected: storage persistence test passes.

- [ ] **Step 6: Commit**

```bash
git add packages/storage
git commit -m "feat: add sqlite run event session artifact stores"
```

## Task 4: Add Filesystem Artifact Content Store

**Files:**
- Create: `packages/storage/src/filesystem-artifact-content-store.ts`
- Modify: `packages/storage/src/index.ts`
- Create: `packages/storage/test/filesystem-artifact-content-store.test.ts`

- [ ] **Step 1: Write filesystem artifact test**

Create `packages/storage/test/filesystem-artifact-content-store.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { FilesystemArtifactContentStore } from "../src/index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("filesystem artifact content store", () => {
  it("writes content under the artifact root and rejects path traversal", async () => {
    const root = mkdtempSync(join(tmpdir(), "switchyard-artifacts-"));
    dirs.push(root);
    const store = new FilesystemArtifactContentStore(root);

    const path = await store.writeText("runs/run_1/transcript.jsonl", "{\"ok\":true}\n");

    expect(path).toBe("runs/run_1/transcript.jsonl");
    expect(readFileSync(join(root, path), "utf8")).toBe("{\"ok\":true}\n");
    await expect(store.writeText("../escape.txt", "bad")).rejects.toThrow("Artifact path escapes root");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @switchyard/storage test -- filesystem-artifact-content-store`

Expected: fails because `FilesystemArtifactContentStore` does not exist.

- [ ] **Step 3: Implement content store**

Create `packages/storage/src/filesystem-artifact-content-store.ts`:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, normalize, relative } from "node:path";

export class FilesystemArtifactContentStore {
  constructor(private readonly root: string) {}

  async writeText(logicalPath: string, content: string): Promise<string> {
    const safePath = this.safePath(logicalPath);
    await mkdir(dirname(safePath), { recursive: true });
    await writeFile(safePath, content, "utf8");
    return normalize(logicalPath).replaceAll("\\", "/");
  }

  private safePath(logicalPath: string): string {
    const target = join(this.root, logicalPath);
    const rel = relative(this.root, target);
    if (rel.startsWith("..") || rel === "" || rel.includes("..")) {
      throw new Error("Artifact path escapes root");
    }
    return target;
  }
}
```

- [ ] **Step 4: Export content store**

Add to `packages/storage/src/index.ts`:

```ts
export * from "./filesystem-artifact-content-store.js";
```

- [ ] **Step 5: Run storage tests**

Run: `pnpm --filter @switchyard/storage test`

Expected: SQLite and filesystem artifact tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/storage
git commit -m "feat: add filesystem artifact content store"
```

## Task 5: Collect Runtime Artifacts and Publish Events

**Files:**
- Modify: `packages/core/src/ports/artifact-store.ts`
- Modify: `packages/core/src/services/runtime-runner-service.ts`
- Create: `packages/core/src/services/run-launcher-service.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/test/core.test.ts`

- [ ] **Step 1: Extend artifact store port**

Update `packages/core/src/ports/artifact-store.ts`:

```ts
import type { Artifact } from "@switchyard/contracts";
import type { GenericStore } from "./generic-stores.js";

export interface ArtifactStore extends GenericStore<Artifact> {
  listByRun(runId: string): Promise<Artifact[]>;
}
```

- [ ] **Step 2: Add failing core test for artifacts**

Add this test to `packages/core/test/core.test.ts`:

```ts
it("runtime runner stores adapter artifacts and emits artifact events", async () => {
  const runs = new MemoryRunStore();
  const events = new MemoryEventStore();
  const sessions = new MemorySessionStore();
  const artifacts = new MemoryArtifactStore();
  const adapter = new EventfulAdapter();
  const run = await createStoredRun(runs);
  const runner = new RuntimeRunnerService({
    runs,
    events,
    sessions,
    artifacts,
    adapters: new Map([["fake", adapter]])
  });

  await runner.start(run);

  expect(await artifacts.listByRun(run.id)).toHaveLength(1);
  expect(events.items.at(-1)?.type).toBe("artifact.created");
});
```

Add `MemoryArtifactStore` to the test file:

```ts
class MemoryArtifactStore implements ArtifactStore {
  readonly items = new Map<string, Artifact>();
  async create(artifact: Artifact): Promise<Artifact> { this.items.set(artifact.id, artifact); return artifact; }
  async get(id: string): Promise<Artifact | undefined> { return this.items.get(id); }
  async update(artifact: Artifact): Promise<Artifact> { this.items.set(artifact.id, artifact); return artifact; }
  async listByRun(runId: string): Promise<Artifact[]> {
    return [...this.items.values()].filter((artifact) => artifact.runId === runId);
  }
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @switchyard/core test`

Expected: fails because `RuntimeRunnerService` does not accept `artifacts`.

- [ ] **Step 4: Update runtime runner dependencies**

Add optional artifact and event bus dependencies to `RuntimeRunnerDependencies`:

```ts
artifacts?: ArtifactStore;
eventBus?: EventBus;
```

After each event append, publish it:

```ts
const stored = await this.deps.events.append(this.normalizeEvent(event, started.id, sequence++));
await this.deps.eventBus?.publish(stored);
```

After adapter events complete, collect artifacts:

```ts
if (this.deps.artifacts) {
  const adapterArtifacts = await adapter.artifacts(this.adapterSession(session));
  for (const artifact of adapterArtifacts) {
    const storedArtifact = await this.deps.artifacts.create({
      ...artifact,
      id: artifact.id.startsWith("artifact_") ? artifact.id : `artifact_${crypto.randomUUID()}`,
      runId: started.id,
      provider: artifact.provider ?? started.provider,
      model: artifact.model ?? started.model,
      createdAt: artifact.createdAt ?? new Date().toISOString()
    });
    const event = await this.deps.events.append(this.eventForRun(
      latest,
      "artifact.created",
      sequence++,
      { artifactId: storedArtifact.id, path: storedArtifact.path, type: storedArtifact.type }
    ));
    await this.deps.eventBus?.publish(event);
  }
}
```

- [ ] **Step 5: Add run launcher service**

Create `packages/core/src/services/run-launcher-service.ts`:

```ts
import type { Run } from "@switchyard/contracts";
import type { RunService } from "./run-service.js";

export class RunLauncherService {
  constructor(private readonly runService: RunService) {}

  launch(run: Run): void {
    queueMicrotask(() => {
      void this.runService.startRun(run.id);
    });
  }
}
```

Export it from `packages/core/src/index.ts`:

```ts
export * from "./services/run-launcher-service.js";
```

- [ ] **Step 6: Run core tests**

Run: `pnpm --filter @switchyard/core test`

Expected: all core tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/core
git commit -m "feat: collect runtime artifacts in core runner"
```

## Task 6: Add REST Artifact Endpoint and Replay SSE Formatting

**Files:**
- Create: `packages/protocol-rest/src/sse.ts`
- Modify: `packages/protocol-rest/src/run-routes.ts`
- Modify: `packages/protocol-rest/test/run-routes.test.ts`

- [ ] **Step 1: Add REST tests**

Add tests to `packages/protocol-rest/test/run-routes.test.ts`:

```ts
it("returns artifacts for a completed fake run", async () => {
  const harness = createRouteHarness();
  const created = await harness.app.inject({
    method: "POST",
    url: "/runs?wait=1",
    payload: fakeRunPayload("Artifact test run")
  });
  const runId = created.json().run.id;

  const response = await harness.app.inject({ method: "GET", url: `/runs/${runId}/artifacts` });

  expect(response.statusCode).toBe(200);
  expect(response.json().artifacts[0]).toMatchObject({ runId, type: "transcript" });
});
```

Add a replay assertion:

```ts
expect(streamResponse.body).toContain("event: run.queued");
expect(streamResponse.body).toContain("event: run.completed");
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm --filter @switchyard/protocol-rest test`

Expected: fails because artifact route and harness artifact store do not exist.

- [ ] **Step 3: Add SSE helper**

Create `packages/protocol-rest/src/sse.ts`:

```ts
import type { SwitchyardEvent } from "@switchyard/contracts";

export function formatSseEvent(event: SwitchyardEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
```

- [ ] **Step 4: Extend route dependencies**

Update `RunRouteDependencies`:

```ts
import type { ArtifactStore, EventBus, RunLauncherService } from "@switchyard/core";

export interface RunRouteDependencies {
  runService: RunService;
  runs: RunStore;
  events: EventStore;
  artifacts?: ArtifactStore;
  eventBus?: EventBus;
  launcher?: RunLauncherService;
}
```

- [ ] **Step 5: Make `POST /runs` optionally non-blocking**

Replace the synchronous start block with:

```ts
const wait = request.query && typeof request.query === "object" && (request.query as Record<string, unknown>)["wait"] === "1";
if (wait) {
  const completed = await deps.runService.startRun(run.id);
  return reply.code(201).send({ run: completed });
}
deps.launcher?.launch(run);
return reply.code(202).send({ run });
```

- [ ] **Step 6: Add artifact route**

Add to `registerRunRoutes`:

```ts
app.get("/runs/:id/artifacts", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const run = await deps.runs.get(id);
  if (!run) {
    return reply.code(404).send({ error: { code: "run_not_found", message: `Run not found: ${id}` } });
  }
  if (!deps.artifacts) {
    return reply.send({ artifacts: [] });
  }
  return { artifacts: await deps.artifacts.listByRun(id) };
});
```

- [ ] **Step 7: Use SSE formatter for replay**

Change event response body to:

```ts
const body = events.map(formatSseEvent).join("");
return reply
  .header("content-type", "text/event-stream; charset=utf-8")
  .header("cache-control", "no-cache")
  .send(body);
```

- [ ] **Step 8: Run REST tests**

Run: `pnpm --filter @switchyard/protocol-rest test`

Expected: run route tests pass.

- [ ] **Step 9: Commit**

```bash
git add packages/protocol-rest
git commit -m "feat: add run artifacts and async run route"
```

## Task 7: Wire Daemon to Local Storage

**Files:**
- Modify: `apps/daemon/package.json`
- Modify: `apps/daemon/src/config.ts`
- Modify: `apps/daemon/src/app.ts`
- Modify: `apps/daemon/test/smoke.test.ts`

- [ ] **Step 1: Add daemon storage dependency**

Update `apps/daemon/package.json` dependencies:

```json
"@switchyard/storage": "workspace:*"
```

- [ ] **Step 2: Extend daemon config**

Update `apps/daemon/src/config.ts`:

```ts
import { join } from "node:path";

export interface DaemonConfig {
  host: string;
  port: number;
  dataDir: string;
  sqlitePath: string;
  artifactDir: string;
}

export function loadDaemonConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const dataDir = env["SWITCHYARD_DATA_DIR"] ?? join(process.cwd(), ".switchyard");
  return {
    host: env["SWITCHYARD_HOST"] ?? "127.0.0.1",
    port: Number(env["SWITCHYARD_PORT"] ?? 4545),
    dataDir,
    sqlitePath: env["SWITCHYARD_SQLITE_PATH"] ?? join(dataDir, "switchyard.sqlite"),
    artifactDir: env["SWITCHYARD_ARTIFACT_DIR"] ?? join(dataDir, "artifacts")
  };
}
```

- [ ] **Step 3: Add storage-backed app factory**

Update `apps/daemon/src/app.ts`:

```ts
import { mkdirSync } from "node:fs";
import Fastify from "fastify";
import { EventBus, RunLauncherService, RunService, RuntimeRunnerService } from "@switchyard/core";
import { registerRunRoutes } from "@switchyard/protocol-rest";
import { FakeRuntimeAdapter, InMemoryEventStore, InMemoryRunStore, InMemorySessionStore } from "@switchyard/testkit";
import {
  FilesystemArtifactContentStore,
  openSqliteStorage,
  SqliteArtifactStore,
  SqliteEventStore,
  SqliteRunStore,
  SqliteSessionStore
} from "@switchyard/storage";
import type { DaemonConfig } from "./config.js";

export function createDaemonApp(config?: DaemonConfig) {
  const app = Fastify({ logger: false });
  const eventBus = new EventBus();
  const adapters = new Map([["fake", new FakeRuntimeAdapter()]]);

  const stores = config ? createStorageStores(config) : {
    runs: new InMemoryRunStore(),
    events: new InMemoryEventStore(),
    sessions: new InMemorySessionStore(),
    artifacts: new InMemoryArtifactStore()
  };

  const runner = new RuntimeRunnerService({ ...stores, eventBus, adapters });
  const runService = new RunService({ runs: stores.runs, events: stores.events, runner });
  const launcher = new RunLauncherService(runService);

  app.get("/health", async () => ({ ok: true }));
  registerRunRoutes(app, { ...stores, eventBus, launcher, runService });
  return app;
}

function createStorageStores(config: DaemonConfig) {
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(config.artifactDir, { recursive: true });
  const { db } = openSqliteStorage(config.sqlitePath);
  void new FilesystemArtifactContentStore(config.artifactDir);
  return {
    runs: new SqliteRunStore(db),
    events: new SqliteEventStore(db),
    sessions: new SqliteSessionStore(db),
    artifacts: new SqliteArtifactStore(db)
  };
}
```

- [ ] **Step 4: Update daemon smoke tests**

Add a persistence test to `apps/daemon/test/smoke.test.ts`:

```ts
it("persists fake run events and artifacts when configured with local storage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "switchyard-daemon-"));
  const config = {
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    sqlitePath: join(dir, "switchyard.sqlite"),
    artifactDir: join(dir, "artifacts")
  };
  const app = createDaemonApp(config);
  const response = await app.inject({
    method: "POST",
    url: "/runs?wait=1",
    payload: {
      runtime: "fake",
      provider: "test",
      model: "test-model",
      adapterType: "process",
      cwd: "/repo",
      task: "Persistent smoke test"
    }
  });
  const runId = response.json().run.id;
  await app.close();

  const reopened = createDaemonApp(config);
  const getRun = await reopened.inject({ method: "GET", url: `/runs/${runId}` });
  const artifacts = await reopened.inject({ method: "GET", url: `/runs/${runId}/artifacts` });

  expect(getRun.json().run.status).toBe("completed");
  expect(artifacts.json().artifacts[0]).toMatchObject({ runId, type: "transcript" });
  await reopened.close();
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 5: Run daemon tests**

Run: `pnpm --filter @switchyard/daemon test`

Expected: smoke tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon
git commit -m "feat: wire daemon to local storage"
```

## Task 8: Add Contract Required-Field Negative Coverage

**Files:**
- Modify: `packages/contracts/test/contracts.test.ts`

- [ ] **Step 1: Add required-field coverage helper**

Add this helper to `packages/contracts/test/contracts.test.ts`:

```ts
import type { z } from "zod";

function expectRequiredFields(schema: z.ZodType, valid: Record<string, unknown>, requiredKeys: string[]): void {
  for (const key of requiredKeys) {
    const value = { ...valid };
    delete value[key];
    expect(() => schema.parse(value), `${key} should be required`).toThrow();
  }
}
```

- [ ] **Step 2: Add required-field tests for exported schemas**

Add one test using known-valid fixtures:

```ts
it("rejects missing required fields for every public contract schema", () => {
  expectRequiredFields(runSchema, {
    id: "run_required",
    runtime: "fake",
    provider: "test",
    model: "test-model",
    adapterType: "process",
    cwd: "/repo",
    task: "test",
    status: "queued",
    placement: "local",
    approvalPolicy: "default",
    timeoutSeconds: 60,
    metadata: {},
    createdAt: "2026-05-11T00:00:00.000Z"
  }, ["id", "runtime", "provider", "model", "adapterType", "cwd", "task", "status", "placement", "approvalPolicy", "timeoutSeconds", "createdAt"]);

  expectRequiredFields(runtimeSessionSchema, {
    id: "session_required",
    runId: "run_required",
    runtime: "fake",
    provider: "test",
    model: "test-model",
    protocol: "process",
    status: "active",
    state: {},
    createdAt: "2026-05-11T00:00:00.000Z"
  }, ["id", "runId", "runtime", "provider", "model", "protocol", "status", "createdAt"]);

  expectRequiredFields(debateSchema, {
    id: "debate_required",
    topic: "Topic",
    mode: "mixed_model_panel",
    status: "created",
    participants: [],
    limits: {
      maxRounds: 1,
      maxTurnsPerAgent: 1,
      maxSearchesPerAgent: 0,
      maxTotalMessages: 2,
      maxDurationSeconds: 60,
      maxCostUsd: 0,
      requireCitations: false,
      requireDisagreementSummary: true,
      stopOnConsensus: false,
      stopOnLowNewInformation: false,
      humanStopAllowed: true
    },
    createdAt: "2026-05-11T00:00:00.000Z"
  }, ["id", "topic", "mode", "status", "participants", "limits", "createdAt"]);

  expectRequiredFields(eventSchema, {
    id: "event_required",
    type: "run.queued",
    runId: "run_required",
    sequence: 0,
    payload: {},
    createdAt: "2026-05-11T00:00:00.000Z"
  }, ["id", "type", "sequence", "payload", "createdAt"]);

  expectRequiredFields(messageSchema, {
    id: "message_required",
    content: "hello",
    deliveryStatus: "queued",
    createdAt: "2026-05-11T00:00:00.000Z"
  }, ["id", "content", "deliveryStatus", "createdAt"]);

  expectRequiredFields(artifactSchema, {
    id: "artifact_required",
    type: "transcript",
    path: "runs/run_required/transcript.jsonl",
    metadata: {},
    createdAt: "2026-05-11T00:00:00.000Z"
  }, ["id", "type", "path", "createdAt"]);

  expectRequiredFields(approvalSchema, {
    id: "approval_required",
    approvalType: "before_commit",
    status: "pending",
    payload: {},
    createdAt: "2026-05-11T00:00:00.000Z"
  }, ["id", "approvalType", "status", "payload", "createdAt"]);

  expectRequiredFields(memoryItemSchema, {
    id: "memory_required",
    scope: "project",
    content: "memory",
    metadata: {},
    createdAt: "2026-05-11T00:00:00.000Z"
  }, ["id", "scope", "content", "createdAt"]);

  expectRequiredFields(evidenceItemSchema, {
    id: "evidence_required",
    sourceType: "manual",
    title: "Evidence",
    reliability: "primary",
    createdAt: "2026-05-11T00:00:00.000Z"
  }, ["id", "sourceType", "title", "reliability", "createdAt"]);

  expectRequiredFields(toolInvocationSchema, {
    id: "tool_required",
    type: "repo",
    status: "queued",
    input: {},
    createdAt: "2026-05-11T00:00:00.000Z"
  }, ["id", "type", "status", "input", "createdAt"]);

  expectRequiredFields(providerSchema, { id: "provider_required", name: "Provider", authMode: "none", status: "available" }, ["id", "name", "authMode", "status"]);
  expectRequiredFields(runtimeSchema, { id: "runtime_required", name: "Runtime", adapterType: "process", status: "available" }, ["id", "name", "adapterType", "status"]);
  expectRequiredFields(placementDecisionSchema, { decision: "local", reason: "test", mode: "local", requiredCapabilities: [], deniedCapabilities: [], approvalRequired: false, policyTrace: [] }, ["decision", "reason", "mode", "requiredCapabilities", "deniedCapabilities", "approvalRequired", "policyTrace"]);
  expectRequiredFields(nodeSchema, { id: "node_required", mode: "local", status: "online", capabilities: [], createdAt: "2026-05-11T00:00:00.000Z" }, ["id", "mode", "status", "capabilities", "createdAt"]);
  expectRequiredFields(userSchema, { id: "user_required", displayName: "User", createdAt: "2026-05-11T00:00:00.000Z" }, ["id", "displayName", "createdAt"]);
  expectRequiredFields(budgetSchema, { status: "within_budget", maxCostUsd: 1, spentCostUsd: 0 }, ["status", "maxCostUsd", "spentCostUsd"]);
  expectRequiredFields(contextPacketSchema, { id: "context_required", target: "run", sections: [], createdAt: "2026-05-11T00:00:00.000Z" }, ["id", "target", "sections", "createdAt"]);
  expectRequiredFields(errorSchema, { code: "validation_failed", message: "bad" }, ["code", "message"]);
});
```

- [ ] **Step 3: Run contracts tests**

Run: `pnpm --filter @switchyard/contracts test`

Expected: all contracts tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/contracts/test/contracts.test.ts
git commit -m "test: add contract required field coverage"
```

## Task 9: Add Placement and Missing In-Memory Stores

**Files:**
- Create: `packages/core/src/ports/placement-store.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/testkit/src/fake-stores.ts`
- Modify: `packages/testkit/src/index.ts`
- Modify: `packages/testkit/test/fake-runtime-adapter.test.ts`

- [ ] **Step 1: Add placement store port**

Create `packages/core/src/ports/placement-store.ts`:

```ts
import type { PlacementDecision } from "@switchyard/contracts";
import type { GenericStore } from "./generic-stores.js";

export interface PlacementDecisionRecord extends PlacementDecision {
  id: string;
  runId?: string;
  createdAt: string;
}

export interface PlacementStore extends GenericStore<PlacementDecisionRecord> {
  listByRun(runId: string): Promise<PlacementDecisionRecord[]>;
}
```

Export it from `packages/core/src/index.ts`:

```ts
export * from "./ports/placement-store.js";
```

- [ ] **Step 2: Add in-memory artifact and placement stores**

Append to `packages/testkit/src/fake-stores.ts`:

```ts
import type { Artifact } from "@switchyard/contracts";
import type { ArtifactStore, PlacementDecisionRecord, PlacementStore } from "@switchyard/core";

export class InMemoryArtifactStore implements ArtifactStore {
  readonly items = new Map<string, Artifact>();
  async create(artifact: Artifact): Promise<Artifact> { this.items.set(artifact.id, artifact); return artifact; }
  async get(id: string): Promise<Artifact | undefined> { return this.items.get(id); }
  async update(artifact: Artifact): Promise<Artifact> { this.items.set(artifact.id, artifact); return artifact; }
  async listByRun(runId: string): Promise<Artifact[]> {
    return [...this.items.values()].filter((artifact) => artifact.runId === runId);
  }
}

export class InMemoryPlacementStore implements PlacementStore {
  readonly items = new Map<string, PlacementDecisionRecord>();
  async create(record: PlacementDecisionRecord): Promise<PlacementDecisionRecord> { this.items.set(record.id, record); return record; }
  async get(id: string): Promise<PlacementDecisionRecord | undefined> { return this.items.get(id); }
  async update(record: PlacementDecisionRecord): Promise<PlacementDecisionRecord> { this.items.set(record.id, record); return record; }
  async listByRun(runId: string): Promise<PlacementDecisionRecord[]> {
    return [...this.items.values()].filter((record) => record.runId === runId);
  }
}
```

- [ ] **Step 3: Export and test stores**

Ensure `packages/testkit/src/index.ts` exports `fake-stores.ts`, then add assertions in `packages/testkit/test/fake-runtime-adapter.test.ts`:

```ts
import { InMemoryArtifactStore, InMemoryPlacementStore } from "../src/index.js";

it("provides in-memory artifact and placement stores", async () => {
  const artifacts = new InMemoryArtifactStore();
  const placements = new InMemoryPlacementStore();
  await artifacts.create({ id: "artifact_memory", runId: "run_123", type: "transcript", path: "runs/run_123/transcript.jsonl", metadata: {}, createdAt: "2026-05-11T00:00:00.000Z" });
  await placements.create({ id: "placement_123", runId: "run_123", decision: "local", reason: "test", mode: "local", requiredCapabilities: [], deniedCapabilities: [], approvalRequired: false, policyTrace: [], createdAt: "2026-05-11T00:00:00.000Z" });

  expect(await artifacts.listByRun("run_123")).toHaveLength(1);
  expect(await placements.listByRun("run_123")).toHaveLength(1);
});
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @switchyard/core test && pnpm --filter @switchyard/testkit test`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core packages/testkit
git commit -m "feat: add placement and artifact test stores"
```

## Task 10: Complete SQLite Store Scope

**Files:**
- Modify: `packages/storage/src/sqlite/schema.ts`
- Modify: `packages/storage/src/sqlite/database.ts`
- Create: `packages/storage/src/sqlite/message-store.ts`
- Create: `packages/storage/src/sqlite/approval-store.ts`
- Create: `packages/storage/src/sqlite/registry-store.ts`
- Create: `packages/storage/src/sqlite/placement-store.ts`
- Modify: `packages/storage/src/index.ts`
- Modify: `packages/storage/test/sqlite-storage.test.ts`

- [ ] **Step 1: Add missing schema tables**

Add these tables to `packages/storage/src/sqlite/schema.ts`:

```ts
export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  fromRunId: text("from_run_id"),
  toRunId: text("to_run_id"),
  channel: text("channel"),
  content: text("content").notNull(),
  attachmentsJson: text("attachments_json").notNull(),
  deliveryStatus: text("delivery_status").notNull(),
  createdAt: text("created_at").notNull(),
  deliveredAt: text("delivered_at")
});

export const approvals = sqliteTable("approvals", {
  id: text("id").primaryKey(),
  runId: text("run_id"),
  approvalType: text("approval_type").notNull(),
  status: text("status").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at")
});

export const providers = sqliteTable("providers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  authMode: text("auth_mode").notNull(),
  status: text("status").notNull()
});

export const runtimes = sqliteTable("runtimes", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  adapterType: text("adapter_type").notNull(),
  status: text("status").notNull()
});

export const models = sqliteTable("models", {
  id: text("id").primaryKey(),
  providerId: text("provider_id").notNull(),
  modelName: text("model_name").notNull(),
  supportsTools: integer("supports_tools", { mode: "boolean" }).notNull(),
  supportsStreaming: integer("supports_streaming", { mode: "boolean" }).notNull(),
  supportsBrowser: integer("supports_browser", { mode: "boolean" }).notNull(),
  status: text("status").notNull()
});

export const placementDecisions = sqliteTable("placement_decisions", {
  id: text("id").primaryKey(),
  runId: text("run_id"),
  decision: text("decision").notNull(),
  reason: text("reason").notNull(),
  mode: text("mode").notNull(),
  targetNode: text("target_node"),
  requiredCapabilitiesJson: text("required_capabilities_json").notNull(),
  deniedCapabilitiesJson: text("denied_capabilities_json").notNull(),
  approvalRequired: integer("approval_required", { mode: "boolean" }).notNull(),
  policyTraceJson: text("policy_trace_json").notNull(),
  createdAt: text("created_at").notNull()
});
```

- [ ] **Step 2: Add matching migration SQL**

Add these `CREATE TABLE IF NOT EXISTS` blocks to `packages/storage/src/sqlite/database.ts` inside the existing `sqlite.exec` migration:

```sql
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  from_run_id TEXT,
  to_run_id TEXT,
  channel TEXT,
  content TEXT NOT NULL,
  attachments_json TEXT NOT NULL,
  delivery_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  approval_type TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  auth_mode TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runtimes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  adapter_type TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  model_name TEXT NOT NULL,
  supports_tools INTEGER NOT NULL,
  supports_streaming INTEGER NOT NULL,
  supports_browser INTEGER NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS placement_decisions (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  mode TEXT NOT NULL,
  target_node TEXT,
  required_capabilities_json TEXT NOT NULL,
  denied_capabilities_json TEXT NOT NULL,
  approval_required INTEGER NOT NULL,
  policy_trace_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS placement_decisions_run_id_idx ON placement_decisions(run_id);
```

- [ ] **Step 3: Implement generic stores**

Create `packages/storage/src/sqlite/message-store.ts`:

```ts
import type { RoutedMessage } from "@switchyard/contracts";
import type { MessageStore } from "@switchyard/core";
import { eq } from "drizzle-orm";
import type { SwitchyardSqliteDatabase } from "./database.js";
import { messages } from "./schema.js";

export class SqliteMessageStore implements MessageStore {
  constructor(private readonly db: SwitchyardSqliteDatabase) {}
  async create(message: RoutedMessage): Promise<RoutedMessage> { this.db.insert(messages).values(toRow(message)).run(); return message; }
  async get(id: string): Promise<RoutedMessage | undefined> {
    const row = this.db.select().from(messages).where(eq(messages.id, id)).get();
    return row ? fromRow(row) : undefined;
  }
  async update(message: RoutedMessage): Promise<RoutedMessage> { this.db.update(messages).set(toRow(message)).where(eq(messages.id, message.id)).run(); return message; }
}

function toRow(message: RoutedMessage) {
  return {
    id: message.id,
    fromRunId: message.fromRunId ?? null,
    toRunId: message.toRunId ?? null,
    channel: message.channel ?? null,
    content: message.content,
    attachmentsJson: JSON.stringify(message.attachments),
    deliveryStatus: message.deliveryStatus,
    createdAt: message.createdAt,
    deliveredAt: message.deliveredAt ?? null
  };
}

function fromRow(row: typeof messages.$inferSelect): RoutedMessage {
  return {
    id: row.id,
    content: row.content,
    attachments: JSON.parse(row.attachmentsJson) as Record<string, unknown>[],
    deliveryStatus: row.deliveryStatus as RoutedMessage["deliveryStatus"],
    createdAt: row.createdAt,
    ...(row.fromRunId ? { fromRunId: row.fromRunId } : {}),
    ...(row.toRunId ? { toRunId: row.toRunId } : {}),
    ...(row.channel ? { channel: row.channel } : {}),
    ...(row.deliveredAt ? { deliveredAt: row.deliveredAt } : {})
  };
}
```

Create `packages/storage/src/sqlite/approval-store.ts`:

```ts
import type { Approval } from "@switchyard/contracts";
import type { ApprovalStore } from "@switchyard/core";
import { eq } from "drizzle-orm";
import type { SwitchyardSqliteDatabase } from "./database.js";
import { approvals } from "./schema.js";

export class SqliteApprovalStore implements ApprovalStore {
  constructor(private readonly db: SwitchyardSqliteDatabase) {}
  async create(approval: Approval): Promise<Approval> { this.db.insert(approvals).values(toRow(approval)).run(); return approval; }
  async get(id: string): Promise<Approval | undefined> {
    const row = this.db.select().from(approvals).where(eq(approvals.id, id)).get();
    return row ? fromRow(row) : undefined;
  }
  async update(approval: Approval): Promise<Approval> { this.db.update(approvals).set(toRow(approval)).where(eq(approvals.id, approval.id)).run(); return approval; }
}

function toRow(approval: Approval) {
  return {
    id: approval.id,
    runId: approval.runId ?? null,
    approvalType: approval.approvalType,
    status: approval.status,
    payloadJson: JSON.stringify(approval.payload),
    createdAt: approval.createdAt,
    resolvedAt: approval.resolvedAt ?? null
  };
}

function fromRow(row: typeof approvals.$inferSelect): Approval {
  return {
    id: row.id,
    approvalType: row.approvalType as Approval["approvalType"],
    status: row.status as Approval["status"],
    payload: JSON.parse(row.payloadJson) as Record<string, unknown>,
    createdAt: row.createdAt,
    ...(row.runId ? { runId: row.runId } : {}),
    ...(row.resolvedAt ? { resolvedAt: row.resolvedAt } : {})
  };
}
```

Create `packages/storage/src/sqlite/registry-store.ts`:

```ts
import type { Model, Provider, RuntimeTarget } from "@switchyard/contracts";
import type { RegistryStore } from "@switchyard/core";
import { eq } from "drizzle-orm";
import type { SwitchyardSqliteDatabase } from "./database.js";
import { models, providers, runtimes } from "./schema.js";

export class SqliteRegistryStore implements RegistryStore {
  constructor(private readonly db: SwitchyardSqliteDatabase) {}
  async createProvider(provider: Provider): Promise<Provider> { this.db.insert(providers).values(provider).run(); return provider; }
  async createRuntime(runtime: RuntimeTarget): Promise<RuntimeTarget> { this.db.insert(runtimes).values(runtime).run(); return runtime; }
  async createModel(model: Model): Promise<Model> { this.db.insert(models).values(model).run(); return model; }
  async getProvider(id: string): Promise<Provider | undefined> { return this.db.select().from(providers).where(eq(providers.id, id)).get(); }
  async getRuntime(id: string): Promise<RuntimeTarget | undefined> {
    const row = this.db.select().from(runtimes).where(eq(runtimes.id, id)).get();
    return row ? { ...row, adapterType: row.adapterType as RuntimeTarget["adapterType"], status: row.status as RuntimeTarget["status"] } : undefined;
  }
  async getModel(id: string): Promise<Model | undefined> {
    const row = this.db.select().from(models).where(eq(models.id, id)).get();
    return row ? { ...row, status: row.status as Model["status"] } : undefined;
  }
}
```

Create `packages/storage/src/sqlite/placement-store.ts`:

```ts
import type { PlacementDecisionRecord, PlacementStore } from "@switchyard/core";
import { eq } from "drizzle-orm";
import type { SwitchyardSqliteDatabase } from "./database.js";
import { placementDecisions } from "./schema.js";

export class SqlitePlacementStore implements PlacementStore {
  constructor(private readonly db: SwitchyardSqliteDatabase) {}
  async create(record: PlacementDecisionRecord): Promise<PlacementDecisionRecord> { this.db.insert(placementDecisions).values(toRow(record)).run(); return record; }
  async get(id: string): Promise<PlacementDecisionRecord | undefined> {
    const row = this.db.select().from(placementDecisions).where(eq(placementDecisions.id, id)).get();
    return row ? fromRow(row) : undefined;
  }
  async update(record: PlacementDecisionRecord): Promise<PlacementDecisionRecord> { this.db.update(placementDecisions).set(toRow(record)).where(eq(placementDecisions.id, record.id)).run(); return record; }
  async listByRun(runId: string): Promise<PlacementDecisionRecord[]> {
    return this.db.select().from(placementDecisions).where(eq(placementDecisions.runId, runId)).all().map(fromRow);
  }
}

function toRow(record: PlacementDecisionRecord) {
  return {
    id: record.id,
    runId: record.runId ?? null,
    decision: record.decision,
    reason: record.reason,
    mode: record.mode,
    targetNode: record.targetNode ?? null,
    requiredCapabilitiesJson: JSON.stringify(record.requiredCapabilities),
    deniedCapabilitiesJson: JSON.stringify(record.deniedCapabilities),
    approvalRequired: record.approvalRequired,
    policyTraceJson: JSON.stringify(record.policyTrace),
    createdAt: record.createdAt
  };
}

function fromRow(row: typeof placementDecisions.$inferSelect): PlacementDecisionRecord {
  return {
    id: row.id,
    decision: row.decision as PlacementDecisionRecord["decision"],
    reason: row.reason,
    mode: row.mode as PlacementDecisionRecord["mode"],
    requiredCapabilities: JSON.parse(row.requiredCapabilitiesJson) as string[],
    deniedCapabilities: JSON.parse(row.deniedCapabilitiesJson) as string[],
    approvalRequired: Boolean(row.approvalRequired),
    policyTrace: JSON.parse(row.policyTraceJson) as string[],
    createdAt: row.createdAt,
    ...(row.runId ? { runId: row.runId } : {}),
    ...(row.targetNode ? { targetNode: row.targetNode } : {})
  };
}
```

- [ ] **Step 4: Expand persistence test**

In `packages/storage/test/sqlite-storage.test.ts`, create one message, approval, provider, runtime, model, and placement decision before closing the first DB handle, then assert they can be read after reopening:

```ts
await messages.create({ id: "message_storage", content: "hello", attachments: [], deliveryStatus: "queued", createdAt: "2026-05-11T00:00:00.000Z" });
await approvals.create({ id: "approval_storage", runId: "run_storage", approvalType: "before_commit", status: "pending", payload: { command: "git commit" }, createdAt: "2026-05-11T00:00:00.000Z" });
await registry.createProvider({ id: "provider_storage", name: "Test", authMode: "none", status: "available" });
await registry.createRuntime({ id: "runtime_storage", name: "Fake", adapterType: "process", status: "available" });
await registry.createModel({ id: "model_storage", providerId: "provider_storage", modelName: "test-model", supportsTools: false, supportsStreaming: true, supportsBrowser: false, status: "available" });
await placements.create({ id: "placement_storage", runId: "run_storage", decision: "local", reason: "test", mode: "local", requiredCapabilities: [], deniedCapabilities: [], approvalRequired: false, policyTrace: [], createdAt: "2026-05-11T00:00:00.000Z" });
```

Expected reopened assertions:

```ts
expect(await new SqliteMessageStore(second.db).get("message_storage")).toMatchObject({ content: "hello" });
expect(await new SqliteApprovalStore(second.db).get("approval_storage")).toMatchObject({ payload: { command: "git commit" } });
expect(await new SqliteRegistryStore(second.db).getProvider("provider_storage")).toMatchObject({ name: "Test" });
expect(await new SqliteRegistryStore(second.db).getRuntime("runtime_storage")).toMatchObject({ name: "Fake" });
expect(await new SqliteRegistryStore(second.db).getModel("model_storage")).toMatchObject({ modelName: "test-model" });
expect(await new SqlitePlacementStore(second.db).listByRun("run_storage")).toHaveLength(1);
```

- [ ] **Step 5: Export stores and run tests**

Export all new stores from `packages/storage/src/index.ts`, then run:

```bash
pnpm --filter @switchyard/storage test
pnpm --filter @switchyard/storage typecheck
```

Expected: both commands pass.

- [ ] **Step 6: Commit**

```bash
git add packages/storage
git commit -m "feat: complete local sqlite store scope"
```

## Task 11: Add Protocol SSE Package With Live Streams

**Files:**
- Create: `packages/protocol-sse/package.json`
- Create: `packages/protocol-sse/tsconfig.json`
- Create: `packages/protocol-sse/src/index.ts`
- Create: `packages/protocol-sse/src/sse-stream.ts`
- Create: `packages/protocol-sse/test/sse-stream.test.ts`
- Modify: `packages/protocol-rest/package.json`
- Modify: `packages/protocol-rest/src/run-routes.ts`
- Modify: `packages/protocol-rest/test/run-routes.test.ts`

- [ ] **Step 1: Add protocol-sse package**

Create `packages/protocol-sse/package.json`:

```json
{
  "name": "@switchyard/protocol-sse",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "lint": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@switchyard/contracts": "workspace:*",
    "@switchyard/core": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.9.3",
    "vitest": "^4.1.5"
  }
}
```

Create `packages/protocol-sse/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 2: Implement SSE helpers**

Create `packages/protocol-sse/src/sse-stream.ts`:

```ts
import type { SwitchyardEvent } from "@switchyard/contracts";
import type { EventBus } from "@switchyard/core";

export function formatSseEvent(event: SwitchyardEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export async function collectReplayAndLiveEvents(input: {
  runId: string;
  replay: SwitchyardEvent[];
  eventBus: EventBus;
  stopAfter: number;
}): Promise<string> {
  const chunks = input.replay.map(formatSseEvent);
  if (chunks.length >= input.stopAfter) {
    return chunks.join("");
  }
  return new Promise((resolve) => {
    const unsubscribe = input.eventBus.subscribe((event) => {
      if (event.runId !== input.runId) return;
      chunks.push(formatSseEvent(event));
      if (chunks.length >= input.stopAfter) {
        unsubscribe();
        resolve(chunks.join(""));
      }
    });
  });
}
```

Create `packages/protocol-sse/src/index.ts`:

```ts
export * from "./sse-stream.js";
```

- [ ] **Step 3: Add SSE tests**

Create `packages/protocol-sse/test/sse-stream.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EventBus } from "@switchyard/core";
import { collectReplayAndLiveEvents, formatSseEvent } from "../src/index.js";

describe("SSE stream helpers", () => {
  it("formats SSE events", () => {
    expect(formatSseEvent({ id: "event_1", type: "run.queued", runId: "run_1", sequence: 0, payload: {}, createdAt: "2026-05-11T00:00:00.000Z" })).toContain("event: run.queued");
  });

  it("combines replay and live events", async () => {
    const eventBus = new EventBus();
    const promise = collectReplayAndLiveEvents({
      runId: "run_1",
      replay: [{ id: "event_1", type: "run.queued", runId: "run_1", sequence: 0, payload: {}, createdAt: "2026-05-11T00:00:00.000Z" }],
      eventBus,
      stopAfter: 2
    });
    await eventBus.publish({ id: "event_2", type: "run.completed", runId: "run_1", sequence: 1, payload: {}, createdAt: "2026-05-11T00:00:01.000Z" });
    expect(await promise).toContain("event: run.completed");
  });
});
```

- [ ] **Step 4: Wire REST to protocol-sse**

Add `@switchyard/protocol-sse` to `packages/protocol-rest/package.json`. Replace local `formatSseEvent` import with:

```ts
import { collectReplayAndLiveEvents, formatSseEvent } from "@switchyard/protocol-sse";
```

In `GET /runs/:id/events`, use `live=1` plus `stopAfter` query params for testable live behavior:

```ts
const query = request.query as Record<string, unknown>;
const live = query["live"] === "1";
const stopAfter = typeof query["stopAfter"] === "string" ? Number(query["stopAfter"]) : events.length;
const body = live && deps.eventBus
  ? await collectReplayAndLiveEvents({ runId: id, replay: events, eventBus: deps.eventBus, stopAfter })
  : events.map(formatSseEvent).join("");
```

- [ ] **Step 5: Run SSE and REST tests**

Run:

```bash
pnpm --filter @switchyard/protocol-sse test
pnpm --filter @switchyard/protocol-rest test
```

Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol-sse packages/protocol-rest
git commit -m "feat: add replay and live sse protocol package"
```

## Task 12: Add Registry REST Routes

**Files:**
- Create: `packages/protocol-rest/src/registry-routes.ts`
- Modify: `packages/protocol-rest/src/index.ts`
- Create: `packages/protocol-rest/test/registry-routes.test.ts`
- Modify: `apps/daemon/src/app.ts`

- [ ] **Step 1: Add registry route implementation**

Create `packages/protocol-rest/src/registry-routes.ts`:

```ts
import type { FastifyInstance } from "fastify";
import type { RegistryStore } from "@switchyard/core";

export function registerRegistryRoutes(app: FastifyInstance, deps: { registry: RegistryStore }): void {
  app.get("/providers/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const provider = await deps.registry.getProvider(id);
    if (!provider) return reply.code(404).send({ error: { code: "provider_not_found", message: `Provider not found: ${id}` } });
    return { provider };
  });

  app.get("/runtimes/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const runtime = await deps.registry.getRuntime(id);
    if (!runtime) return reply.code(404).send({ error: { code: "runtime_not_found", message: `Runtime not found: ${id}` } });
    return { runtime };
  });

  app.get("/models/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const model = await deps.registry.getModel(id);
    if (!model) return reply.code(404).send({ error: { code: "model_not_found", message: `Model not found: ${id}` } });
    return { model };
  });
}
```

Export it from `packages/protocol-rest/src/index.ts`:

```ts
export * from "./registry-routes.js";
```

- [ ] **Step 2: Add route tests**

Create `packages/protocol-rest/test/registry-routes.test.ts`:

```ts
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { Model, Provider, RuntimeTarget } from "@switchyard/contracts";
import type { RegistryStore } from "@switchyard/core";
import { registerRegistryRoutes } from "../src/index.js";

describe("registry routes", () => {
  it("returns providers, runtimes, and models", async () => {
    const registry = new MemoryRegistryStore();
    await registry.createProvider({ id: "provider_test", name: "Test Provider", authMode: "none", status: "available" });
    await registry.createRuntime({ id: "runtime_fake", name: "Fake Runtime", adapterType: "process", status: "available" });
    await registry.createModel({ id: "model_test", providerId: "provider_test", modelName: "test-model", supportsTools: false, supportsStreaming: true, supportsBrowser: false, status: "available" });
    const app = Fastify();
    registerRegistryRoutes(app, { registry });

    expect((await app.inject({ method: "GET", url: "/providers/provider_test" })).json().provider.name).toBe("Test Provider");
    expect((await app.inject({ method: "GET", url: "/runtimes/runtime_fake" })).json().runtime.name).toBe("Fake Runtime");
    expect((await app.inject({ method: "GET", url: "/models/model_test" })).json().model.modelName).toBe("test-model");
  });
});

class MemoryRegistryStore implements RegistryStore {
  private readonly providers = new Map<string, Provider>();
  private readonly runtimes = new Map<string, RuntimeTarget>();
  private readonly models = new Map<string, Model>();
  async createProvider(provider: Provider): Promise<Provider> { this.providers.set(provider.id, provider); return provider; }
  async createRuntime(runtime: RuntimeTarget): Promise<RuntimeTarget> { this.runtimes.set(runtime.id, runtime); return runtime; }
  async createModel(model: Model): Promise<Model> { this.models.set(model.id, model); return model; }
  async getProvider(id: string): Promise<Provider | undefined> { return this.providers.get(id); }
  async getRuntime(id: string): Promise<RuntimeTarget | undefined> { return this.runtimes.get(id); }
  async getModel(id: string): Promise<Model | undefined> { return this.models.get(id); }
}
```

The core assertions are:

```ts
expect((await app.inject({ method: "GET", url: "/providers/provider_test" })).json().provider.name).toBe("Test Provider");
expect((await app.inject({ method: "GET", url: "/runtimes/runtime_fake" })).json().runtime.name).toBe("Fake Runtime");
expect((await app.inject({ method: "GET", url: "/models/model_test" })).json().model.modelName).toBe("test-model");
```

- [ ] **Step 3: Wire daemon registry**

In `apps/daemon/src/app.ts`, include `registry: new SqliteRegistryStore(db)` in `createStorageStores(config)`.

Change `createDaemonApp` to `async function createDaemonApp(config?: DaemonConfig)` and update daemon tests/main to call `await createDaemonApp(...)`. After creating stores, seed the fake registry if records are absent:

```ts
if (!(await stores.registry.getProvider("provider_test"))) {
  await stores.registry.createProvider({ id: "provider_test", name: "Test Provider", authMode: "none", status: "available" });
}
if (!(await stores.registry.getRuntime("runtime_fake"))) {
  await stores.registry.createRuntime({ id: "runtime_fake", name: "Fake Runtime", adapterType: "process", status: "available" });
}
if (!(await stores.registry.getModel("model_test"))) {
  await stores.registry.createModel({ id: "model_test", providerId: "provider_test", modelName: "test-model", supportsTools: false, supportsStreaming: true, supportsBrowser: false, status: "available" });
}
```

Register routes with:

```ts
registerRegistryRoutes(app, { registry: stores.registry });
```

- [ ] **Step 4: Run REST and daemon tests**

Run:

```bash
pnpm --filter @switchyard/protocol-rest test
pnpm --filter @switchyard/daemon test
```

Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol-rest apps/daemon
git commit -m "feat: add registry rest routes"
```

## Task 13: Persist Artifact Content End-to-End

**Files:**
- Modify: `packages/core/src/services/runtime-runner-service.ts`
- Modify: `packages/testkit/src/fake-runtime-adapter.ts`
- Modify: `packages/storage/src/filesystem-artifact-content-store.ts`
- Modify: `apps/daemon/src/app.ts`
- Modify: `apps/daemon/test/smoke.test.ts`

- [ ] **Step 1: Add optional content to fake artifacts**

Update fake adapter `artifacts()` return:

```ts
metadata: { content: "{\"type\":\"runtime.output\",\"text\":\"fake runtime output\"}\n" },
```

- [ ] **Step 2: Add artifact content dependency**

Define in `RuntimeRunnerDependencies`:

```ts
artifactContent?: { writeText(path: string, content: string): Promise<string> };
```

When storing each artifact:

```ts
const content = typeof artifact.metadata["content"] === "string" ? artifact.metadata["content"] : undefined;
const path = content && this.deps.artifactContent ? await this.deps.artifactContent.writeText(artifact.path, content) : artifact.path;
const storedArtifact = await this.deps.artifacts.create({
  ...artifact,
  path,
  metadata: { ...artifact.metadata, contentStored: Boolean(content) },
  runId: started.id,
  provider: artifact.provider ?? started.provider,
  model: artifact.model ?? started.model
});
```

- [ ] **Step 3: Wire daemon content store**

In `apps/daemon/src/app.ts`, pass:

```ts
artifactContent: new FilesystemArtifactContentStore(config.artifactDir)
```

to `RuntimeRunnerService` when config is provided.

- [ ] **Step 4: Verify file content in smoke test**

In daemon persistence smoke test:

```ts
const artifact = artifacts.json().artifacts[0];
expect(readFileSync(join(config.artifactDir, artifact.path), "utf8")).toContain("fake runtime output");
```

- [ ] **Step 5: Run core, storage, daemon tests**

Run:

```bash
pnpm --filter @switchyard/core test
pnpm --filter @switchyard/storage test
pnpm --filter @switchyard/daemon test
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core packages/testkit packages/storage apps/daemon
git commit -m "feat: persist fake runtime artifact content"
```

## Task 14: Update Docs and Verify

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/superpowers/plans/2026-05-11-switchyard-master-implementation-plan.md`

- [ ] **Step 1: Update README local testing**

In `README.md`, update the local testing section to state:

```markdown
The current local MVP runs a fake runtime through the Switchyard daemon. It uses local SQLite state and filesystem artifact metadata by default. It does not call Claude, Codex, OpenCode, or any external model yet.
```

Add artifact check:

```bash
curl -s http://127.0.0.1:4545/runs/<RUN_ID>/artifacts
```

- [ ] **Step 2: Update changelog**

Add under `0.1.0`:

```markdown
- Added local SQLite-backed run, event, session, and artifact stores.
- Added local SQLite-backed message, approval, registry, and placement-decision stores.
- Added filesystem artifact content storage for local daemon mode.
- Added `GET /runs/:id/artifacts`.
- Added registry lookup routes for providers, runtimes, and models.
- Added `@switchyard/protocol-sse` for replay and live run event streams.
- Added async run launch support for local daemon execution.
- Added required-field negative contract coverage for public schemas.
```

- [ ] **Step 3: Mark master plan Phase 0/1 status**

In `docs/superpowers/plans/2026-05-11-switchyard-master-implementation-plan.md`, add a short status note under Phase 1:

```markdown
Status note, 2026-05-11: Phase 1 is complete when the storage-backed fake daemon, artifact listing, and replay/live event behavior in the Phase 0/1 gap plan are merged and verified.
```

- [ ] **Step 4: Run full verification**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm lint
```

Expected: all commands pass.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md docs/superpowers/plans/2026-05-11-switchyard-master-implementation-plan.md
git commit -m "docs: update phase 1 local mvp status"
```

## Self-Review

Spec coverage:

- Phase 0 explicit service files: Task 1.
- Phase 0 reusable adapter contract test: Task 1.
- Contract required-field negative coverage: Task 8.
- Placement-decision persistence port: Task 9.
- Testkit artifact and placement stores: Task 9.
- SQLite persistence for runs/events/sessions/artifacts: Tasks 2 and 3.
- SQLite persistence for messages/approvals/registry/placement decisions: Task 10.
- Filesystem artifact storage: Task 4.
- Runtime artifact collection and `artifact.created`: Tasks 5 and 13.
- Artifact file content persistence: Task 13.
- Non-blocking run launch path: Tasks 5 and 6.
- Artifact route: Task 6.
- Protocol-level replay/live SSE package: Task 11.
- Registry routes: Task 12.
- Daemon storage wiring and persistence smoke coverage: Task 7.
- Docs/changelog/master plan accuracy: Task 14.

Placeholder scan:

- No `TBD` markers.
- No unresolved file paths.
- No empty test instructions.

Type consistency:

- `RunStore`, `EventStore`, `SessionStore`, and `ArtifactStore` match current core port naming.
- `MessageStore`, `ApprovalStore`, `RegistryStore`, and `PlacementStore` cover the remaining Phase 1.2 persistence requirements.
- `adapterType`, `approvalPolicy`, `timeoutSeconds`, `createdAt`, `startedAt`, and `endedAt` match the current contract casing.
- `GET /runs/:id/artifacts` uses `ArtifactStore.listByRun`, which Task 5 adds before Task 6 uses it.
