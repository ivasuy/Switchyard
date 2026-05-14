# Codex Exec-JSON Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real local Codex provider that runs `codex exec --json` through Switchyard's existing `/runs` lifecycle.

**Architecture:** Create a new `@switchyard/adapters` package with focused Codex modules: model catalog discovery, JSONL event parsing, argv construction, and the `CodexExecJsonAdapter`. Wire the daemon to seed Codex registry facts and register the adapter while keeping core protocol-neutral. Route metadata remains generic; Codex-specific options live under `run.metadata`.

**Tech Stack:** TypeScript, Node child_process, readline-style JSONL parsing, Vitest, Fastify inject tests, existing Switchyard contracts/core/storage/testkit packages.

---

## File Map

- Create `packages/adapters/package.json`: package manifest for runtime adapters.
- Create `packages/adapters/tsconfig.json`: TypeScript project config.
- Create `packages/adapters/src/index.ts`: public exports.
- Create `packages/adapters/src/codex/types.ts`: Codex option, catalog, process, and event helper types.
- Create `packages/adapters/src/codex/codex-model-catalog.ts`: runs/parses `codex --version` and `codex debug models`.
- Create `packages/adapters/src/codex/codex-jsonl-parser.ts`: maps Codex JSONL objects to Switchyard events.
- Create `packages/adapters/src/codex/codex-exec-json-adapter.ts`: implements `RuntimeAdapter`.
- Create `packages/adapters/test/codex-jsonl-parser.test.ts`: parser fixtures and edge cases.
- Create `packages/adapters/test/codex-model-catalog.test.ts`: catalog parsing and failure behavior.
- Create `packages/adapters/test/codex-exec-json-adapter.test.ts`: adapter behavior using a fake process factory.
- Modify `packages/protocol-rest/src/run-routes.ts`: preserve typed Codex metadata in run creation and map unsupported input to `409`.
- Modify `packages/protocol-rest/test/run-routes.test.ts`: metadata pass-through and unsupported input coverage.
- Modify `apps/daemon/src/app.ts`: register `CodexExecJsonAdapter` and seed OpenAI/Codex registry records.
- Modify `apps/daemon/test/smoke.test.ts`: assert Codex registry records are exposed without requiring a live Codex run.
- Modify `package.json` only if workspace scripts need no change; `packages/*` is already included by `pnpm-workspace.yaml`.
- Modify `CHANGELOG.md`: document Codex provider slice.
- Optional create `docs/adapters/verification/codex-exec-json.md`: paste live probe notes after manual local verification.

## Task 1: Create The Adapters Package

**Files:**
- Create: `packages/adapters/package.json`
- Create: `packages/adapters/tsconfig.json`
- Create: `packages/adapters/src/index.ts`
- Create: `packages/adapters/src/codex/types.ts`

- [ ] **Step 1: Add package manifest**

Create `packages/adapters/package.json`:

```json
{
  "name": "@switchyard/adapters",
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
    "@switchyard/core": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.9.3",
    "vitest": "^4.1.5"
  }
}
```

- [ ] **Step 2: Add TypeScript config**

Create `packages/adapters/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "dist"
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Add Codex shared types**

Create `packages/adapters/src/codex/types.ts`:

```ts
import type { ChildProcessWithoutNullStreams } from "node:child_process";

export type CodexReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type CodexReasoningSummary = "auto" | "concise" | "detailed" | "none";
export type CodexVerbosity = "low" | "medium" | "high";
export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";

export interface CodexRunOptions {
  reasoningEffort?: CodexReasoningEffort;
  reasoningSummary?: CodexReasoningSummary;
  verbosity?: CodexVerbosity;
  sandbox?: CodexSandbox;
  skipGitRepoCheck?: boolean;
  ephemeral?: boolean;
}

export interface CodexModelCatalogEntry {
  slug: string;
  displayName?: string;
  description?: string;
  defaultReasoningLevel?: string;
  supportedReasoningLevels: string[];
  supportsReasoningSummaries?: boolean;
  supportsVerbosity?: boolean;
  defaultVerbosity?: string;
}

export interface CodexCatalogProbe {
  ok: boolean;
  version?: string;
  models: CodexModelCatalogEntry[];
  message?: string;
}

export type CodexProcessFactory = (
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
) => ChildProcessWithoutNullStreams;
```

- [ ] **Step 4: Add package export**

Create `packages/adapters/src/index.ts`:

```ts
export * from "./codex/types.js";
export * from "./codex/codex-model-catalog.js";
export * from "./codex/codex-jsonl-parser.js";
export * from "./codex/codex-exec-json-adapter.js";
```

- [ ] **Step 5: Run package typecheck**

Run: `pnpm --filter @switchyard/adapters typecheck`

Expected: fails because the exported Codex implementation files do not exist yet. Keep this failure; later tasks make it pass.

## Task 2: Parse Codex Model Catalog

**Files:**
- Create: `packages/adapters/src/codex/codex-model-catalog.ts`
- Create: `packages/adapters/test/codex-model-catalog.test.ts`

- [ ] **Step 1: Write catalog tests**

Create `packages/adapters/test/codex-model-catalog.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseCodexModelCatalog, validateCodexRunOptions } from "../src/index.js";

describe("codex model catalog", () => {
  it("parses local Codex model catalog JSON", () => {
    const parsed = parseCodexModelCatalog(JSON.stringify({
      models: [
        {
          slug: "gpt-5.5",
          display_name: "GPT-5.5",
          description: "Frontier model",
          default_reasoning_level: "medium",
          supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }],
          supports_reasoning_summaries: true,
          support_verbosity: true,
          default_verbosity: "low"
        }
      ]
    }));

    expect(parsed).toEqual([
      {
        slug: "gpt-5.5",
        displayName: "GPT-5.5",
        description: "Frontier model",
        defaultReasoningLevel: "medium",
        supportedReasoningLevels: ["low", "medium", "high", "xhigh"],
        supportsReasoningSummaries: true,
        supportsVerbosity: true,
        defaultVerbosity: "low"
      }
    ]);
  });

  it("rejects unsupported reasoning effort when catalog has the selected model", () => {
    expect(() => validateCodexRunOptions({
      model: "gpt-5.5",
      options: { reasoningEffort: "minimal" },
      models: [{ slug: "gpt-5.5", supportedReasoningLevels: ["low", "medium", "high", "xhigh"] }]
    })).toThrow("Reasoning effort minimal is not supported by Codex model gpt-5.5");
  });

  it("allows validation when catalog is unavailable", () => {
    expect(validateCodexRunOptions({
      model: "gpt-5.5",
      options: { reasoningEffort: "high" },
      models: []
    })).toEqual({ reasoningEffort: "high" });
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run: `pnpm --filter @switchyard/adapters test -- codex-model-catalog`

Expected: FAIL because `codex-model-catalog.ts` does not exist.

- [ ] **Step 3: Implement catalog parsing and validation**

Create `packages/adapters/src/codex/codex-model-catalog.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CodexCatalogProbe, CodexModelCatalogEntry, CodexRunOptions } from "./types.js";

const execFileAsync = promisify(execFile);

export function parseCodexModelCatalog(raw: string): CodexModelCatalogEntry[] {
  const parsed = JSON.parse(raw) as { models?: unknown[] };
  const models = Array.isArray(parsed.models) ? parsed.models : [];

  return models
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .map((entry) => ({
      slug: String(entry.slug ?? ""),
      displayName: typeof entry.display_name === "string" ? entry.display_name : undefined,
      description: typeof entry.description === "string" ? entry.description : undefined,
      defaultReasoningLevel: typeof entry.default_reasoning_level === "string" ? entry.default_reasoning_level : undefined,
      supportedReasoningLevels: parseReasoningLevels(entry.supported_reasoning_levels),
      supportsReasoningSummaries: typeof entry.supports_reasoning_summaries === "boolean" ? entry.supports_reasoning_summaries : undefined,
      supportsVerbosity: typeof entry.support_verbosity === "boolean" ? entry.support_verbosity : undefined,
      defaultVerbosity: typeof entry.default_verbosity === "string" ? entry.default_verbosity : undefined
    }))
    .filter((entry) => entry.slug.length > 0);
}

export function validateCodexRunOptions(input: {
  model: string;
  options: CodexRunOptions;
  models: CodexModelCatalogEntry[];
}): CodexRunOptions {
  const selected = input.models.find((model) => model.slug === input.model);
  if (!selected || !input.options.reasoningEffort) {
    return input.options;
  }
  if (!selected.supportedReasoningLevels.includes(input.options.reasoningEffort)) {
    throw new Error(`Reasoning effort ${input.options.reasoningEffort} is not supported by Codex model ${input.model}`);
  }
  return input.options;
}

export async function probeCodexCatalog(command = "codex"): Promise<CodexCatalogProbe> {
  try {
    const version = (await execFileAsync(command, ["--version"])).stdout.trim();
    try {
      const catalog = await execFileAsync(command, ["debug", "models"]);
      return {
        ok: true,
        version,
        models: parseCodexModelCatalog(catalog.stdout)
      };
    } catch (error) {
      return {
        ok: true,
        version,
        models: [],
        message: error instanceof Error ? error.message : String(error)
      };
    }
  } catch (error) {
    return {
      ok: false,
      models: [],
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

function parseReasoningLevels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      if (entry && typeof entry === "object" && typeof (entry as { effort?: unknown }).effort === "string") {
        return (entry as { effort: string }).effort;
      }
      return undefined;
    })
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}
```

- [ ] **Step 4: Run catalog tests**

Run: `pnpm --filter @switchyard/adapters test -- codex-model-catalog`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters
git commit -m "feat: add codex model catalog parser"
```

## Task 3: Parse Codex JSONL Events

**Files:**
- Create: `packages/adapters/src/codex/codex-jsonl-parser.ts`
- Create: `packages/adapters/test/codex-jsonl-parser.test.ts`

- [ ] **Step 1: Write parser tests**

Create `packages/adapters/test/codex-jsonl-parser.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseCodexJsonLine, codexEventToSwitchyardEvent } from "../src/index.js";

describe("codex jsonl parser", () => {
  it("maps lifecycle and message events", () => {
    const runId = "run_codex";
    const createdAt = "2026-05-14T00:00:00.000Z";
    const events = [
      { type: "thread.started", thread_id: "thread_123" },
      { type: "turn.started" },
      { type: "item.completed", item: { type: "agent_message", text: "hello from codex" } },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }
    ].map((event, index) => codexEventToSwitchyardEvent(event, { runId, sequence: index, createdAt }));

    expect(events.map((event) => event.type)).toEqual([
      "runtime.status",
      "runtime.status",
      "runtime.output",
      "run.completed"
    ]);
    expect(events[2]?.payload).toMatchObject({ text: "hello from codex", codexType: "item.completed" });
    expect(events[3]?.payload).toMatchObject({ status: "completed" });
  });

  it("maps turn failures and top-level errors to run.failed", () => {
    const failed = codexEventToSwitchyardEvent(
      { type: "turn.failed", error: { message: "model failed" } },
      { runId: "run_codex", sequence: 0, createdAt: "2026-05-14T00:00:00.000Z" }
    );
    const error = codexEventToSwitchyardEvent(
      { type: "error", message: "bad auth" },
      { runId: "run_codex", sequence: 1, createdAt: "2026-05-14T00:00:00.000Z" }
    );

    expect(failed.type).toBe("run.failed");
    expect(error.type).toBe("run.failed");
  });

  it("parses JSON lines and rejects invalid JSON", () => {
    expect(parseCodexJsonLine("{\"type\":\"turn.started\"}")).toEqual({ type: "turn.started" });
    expect(() => parseCodexJsonLine("not-json")).toThrow("Invalid Codex JSONL line");
  });
});
```

- [ ] **Step 2: Run the failing parser tests**

Run: `pnpm --filter @switchyard/adapters test -- codex-jsonl-parser`

Expected: FAIL because the parser module does not exist.

- [ ] **Step 3: Implement parser**

Create `packages/adapters/src/codex/codex-jsonl-parser.ts`:

```ts
import type { SwitchyardEvent } from "@switchyard/contracts";

export function parseCodexJsonLine(line: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("line is not an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Codex JSONL line: ${message}`);
  }
}

export function codexEventToSwitchyardEvent(
  event: Record<string, unknown>,
  context: { runId: string; sequence: number; createdAt: string }
): SwitchyardEvent {
  const codexType = typeof event.type === "string" ? event.type : "unknown";
  const base = {
    id: `event_${crypto.randomUUID()}`,
    runId: context.runId,
    sequence: context.sequence,
    createdAt: context.createdAt
  };

  if (codexType === "turn.completed") {
    return { ...base, type: "run.completed", payload: { status: "completed", codexType, usage: event.usage } };
  }
  if (codexType === "turn.failed" || codexType === "error") {
    return { ...base, type: "run.failed", payload: { status: "failed", codexType, error: event.error ?? event.message ?? event } };
  }

  const text = extractText(event);
  if (text) {
    return { ...base, type: "runtime.output", payload: { text, codexType } };
  }

  return {
    ...base,
    type: "runtime.status",
    payload: {
      status: statusForCodexType(codexType),
      codexType,
      threadId: event.thread_id
    }
  };
}

function statusForCodexType(type: string): string {
  if (type === "thread.started") {
    return "thread_started";
  }
  if (type === "turn.started") {
    return "turn_started";
  }
  return "event";
}

function extractText(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["text", "message", "delta"]) {
    if (typeof record[key] === "string" && record[key].length > 0) {
      return record[key] as string;
    }
  }
  if (record.item) {
    return extractText(record.item);
  }
  if (Array.isArray(record.content)) {
    const parts = record.content
      .map((part) => extractText(part))
      .filter((part): part is string => typeof part === "string" && part.length > 0);
    return parts.length > 0 ? parts.join("") : undefined;
  }
  return undefined;
}
```

- [ ] **Step 4: Run parser tests**

Run: `pnpm --filter @switchyard/adapters test -- codex-jsonl-parser`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters
git commit -m "feat: parse codex jsonl events"
```

## Task 4: Implement Codex Exec-JSON Adapter

**Files:**
- Create: `packages/adapters/src/codex/codex-exec-json-adapter.ts`
- Create: `packages/adapters/test/codex-exec-json-adapter.test.ts`

- [ ] **Step 1: Write adapter tests with a fake process**

Create `packages/adapters/test/codex-exec-json-adapter.test.ts`:

```ts
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { CodexExecJsonAdapter } from "../src/index.js";

describe("CodexExecJsonAdapter", () => {
  it("builds args, streams events, and returns transcript artifact", async () => {
    const fake = new FakeCodexProcess();
    const adapter = new CodexExecJsonAdapter({
      command: "codex",
      processFactory: (args, options) => {
        fake.args = args;
        fake.cwd = options.cwd;
        queueMicrotask(() => {
          fake.stdout.write("{\"type\":\"thread.started\",\"thread_id\":\"thread_1\"}\n");
          fake.stdout.write("{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"done\"}}\n");
          fake.stdout.write("{\"type\":\"turn.completed\"}\n");
          fake.stdout.end();
          fake.emit("exit", 0, null);
        });
        return fake as never;
      },
      modelCatalog: [{ slug: "gpt-5.5", supportedReasoningLevels: ["low", "medium", "high", "xhigh"] }]
    });

    const session = await adapter.start({
      runId: "run_codex",
      model: "gpt-5.5",
      cwd: "/repo",
      task: "do work",
      metadata: { reasoningEffort: "high", reasoningSummary: "auto", verbosity: "low", sandbox: "read-only" }
    });
    const events = [];
    for await (const event of adapter.events({ ...session, runId: "run_codex" })) {
      events.push(event);
    }
    const artifacts = await adapter.artifacts({ ...session, runId: "run_codex" });

    expect(fake.cwd).toBe("/repo");
    expect(fake.args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.5",
      "-c",
      "model_reasoning_effort=\"high\"",
      "-c",
      "model_reasoning_summary=\"auto\"",
      "-c",
      "model_verbosity=\"low\"",
      "--cd",
      "/repo",
      "--sandbox",
      "read-only",
      "do work"
    ]);
    expect(events.map((event) => event.type)).toEqual(["runtime.status", "runtime.output", "run.completed"]);
    expect(artifacts[0]?.metadata.content).toContain("\"turn.completed\"");
  });

  it("emits run.failed for non-zero process exit without terminal event", async () => {
    const fake = new FakeCodexProcess();
    const adapter = new CodexExecJsonAdapter({
      processFactory: () => {
        queueMicrotask(() => {
          fake.stderr.write("auth failed\n");
          fake.stdout.end();
          fake.emit("exit", 1, null);
        });
        return fake as never;
      }
    });

    const session = await adapter.start({ runId: "run_codex", model: "gpt-5.5", cwd: "/repo", task: "fail", metadata: {} });
    const events = [];
    for await (const event of adapter.events({ ...session, runId: "run_codex" })) {
      events.push(event);
    }

    expect(events.at(-1)).toMatchObject({ type: "run.failed" });
  });

  it("rejects send because exec-json is not interactive", async () => {
    const adapter = new CodexExecJsonAdapter();
    await expect(adapter.send({ sessionId: "session_codex" }, { text: "continue" })).rejects.toThrow("does not support input");
  });
});

class FakeCodexProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  pid = 1234;
  killed = false;
  args: string[] = [];
  cwd = "";

  kill(): boolean {
    this.killed = true;
    this.emit("exit", null, "SIGTERM");
    return true;
  }
}
```

- [ ] **Step 2: Run the failing adapter tests**

Run: `pnpm --filter @switchyard/adapters test -- codex-exec-json-adapter`

Expected: FAIL because the adapter module does not exist.

- [ ] **Step 3: Implement adapter**

Create `packages/adapters/src/codex/codex-exec-json-adapter.ts`:

```ts
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Artifact, SwitchyardEvent } from "@switchyard/contracts";
import type { RuntimeAdapter, RuntimeAdapterCheck, RuntimeStartResult } from "@switchyard/core";
import { codexEventToSwitchyardEvent, parseCodexJsonLine } from "./codex-jsonl-parser.js";
import { probeCodexCatalog, validateCodexRunOptions } from "./codex-model-catalog.js";
import type { CodexModelCatalogEntry, CodexProcessFactory, CodexRunOptions } from "./types.js";

interface CodexAdapterSession {
  process: ReturnType<CodexProcessFactory>;
  rawLines: string[];
  stderrLines: string[];
  terminalSeen: boolean;
  exitCode?: number | null;
}

export class CodexInputUnsupportedError extends Error {
  constructor() {
    super("Codex exec-json does not support input after start");
    this.name = "CodexInputUnsupportedError";
  }
}

export class CodexExecJsonAdapter implements RuntimeAdapter {
  readonly id = "codex";
  private readonly command: string;
  private readonly processFactory: CodexProcessFactory;
  private readonly modelCatalog: CodexModelCatalogEntry[];
  private readonly sessions = new Map<string, CodexAdapterSession>();

  constructor(options: { command?: string; processFactory?: CodexProcessFactory; modelCatalog?: CodexModelCatalogEntry[] } = {}) {
    this.command = options.command ?? "codex";
    this.processFactory = options.processFactory ?? ((args, processOptions) => spawn(this.command, args, processOptions));
    this.modelCatalog = options.modelCatalog ?? [];
  }

  async check(): Promise<RuntimeAdapterCheck> {
    const probe = await probeCodexCatalog(this.command);
    return {
      ok: probe.ok,
      message: probe.message,
      details: {
        version: probe.version,
        models: probe.models
      }
    };
  }

  async start(request: Record<string, unknown>): Promise<RuntimeStartResult> {
    const sessionId = `session_${crypto.randomUUID()}`;
    const cwd = requiredString(request.cwd, "cwd");
    const model = requiredString(request.model, "model");
    const task = requiredString(request.task, "task");
    const metadata = isRecord(request.metadata) ? request.metadata : {};
    const options = validateCodexRunOptions({
      model,
      options: codexRunOptions(metadata),
      models: this.modelCatalog
    });
    const args = buildCodexExecArgs({ model, cwd, task, options });
    const child = this.processFactory(args, { cwd, env: process.env });
    const session: CodexAdapterSession = {
      process: child,
      rawLines: [],
      stderrLines: [],
      terminalSeen: false
    };

    child.stderr.on("data", (chunk: Buffer) => {
      session.stderrLines.push(chunk.toString("utf8"));
    });
    child.on("exit", (code) => {
      session.exitCode = code;
    });
    this.sessions.set(sessionId, session);
    return { sessionId, processId: child.pid };
  }

  async send(): Promise<void> {
    throw new CodexInputUnsupportedError();
  }

  async cancel(session: Record<string, unknown>): Promise<void> {
    const active = this.requireSession(session);
    active.process.kill("SIGTERM");
  }

  async *events(session: Record<string, unknown>): AsyncIterable<SwitchyardEvent> {
    const active = this.requireSession(session);
    const runId = requiredString(session.runId, "runId");
    let sequence = 0;
    const lines = createInterface({ input: active.process.stdout });

    for await (const line of lines) {
      if (line.length === 0) {
        continue;
      }
      active.rawLines.push(line);
      try {
        const parsed = parseCodexJsonLine(line);
        const event = codexEventToSwitchyardEvent(parsed, { runId, sequence: sequence++, createdAt: new Date().toISOString() });
        if (event.type === "run.completed" || event.type === "run.failed") {
          active.terminalSeen = true;
        }
        yield event;
      } catch (error) {
        active.terminalSeen = true;
        yield {
          id: `event_${crypto.randomUUID()}`,
          type: "run.failed",
          runId,
          sequence: sequence++,
          payload: { status: "failed", error: error instanceof Error ? error.message : String(error) },
          createdAt: new Date().toISOString()
        };
        return;
      }
    }

    if (!active.terminalSeen && active.exitCode && active.exitCode !== 0) {
      yield {
        id: `event_${crypto.randomUUID()}`,
        type: "run.failed",
        runId,
        sequence,
        payload: { status: "failed", exitCode: active.exitCode, stderr: active.stderrLines.join("") },
        createdAt: new Date().toISOString()
      };
    }
  }

  async tools(): Promise<string[]> {
    return [];
  }

  async artifacts(session: Record<string, unknown>): Promise<Artifact[]> {
    const active = this.requireSession(session);
    const runId = requiredString(session.runId, "runId");
    const content = [
      ...active.rawLines.map((line) => `${line}\n`),
      active.stderrLines.length > 0 ? JSON.stringify({ type: "stderr", text: active.stderrLines.join("") }) + "\n" : ""
    ].join("");

    return [{
      id: "artifact_codex_transcript",
      type: "transcript",
      path: `runs/${runId}/codex-transcript.jsonl`,
      metadata: { content, runtime: "codex", mode: "exec-json" },
      createdAt: new Date().toISOString()
    }];
  }

  private requireSession(session: Record<string, unknown>): CodexAdapterSession {
    const sessionId = requiredString(session.sessionId, "sessionId");
    const active = this.sessions.get(sessionId);
    if (!active) {
      throw new Error(`Codex session not found: ${sessionId}`);
    }
    return active;
  }
}

export function buildCodexExecArgs(input: { model: string; cwd: string; task: string; options: CodexRunOptions }): string[] {
  const args = ["exec", "--json", "--model", input.model];
  if (input.options.reasoningEffort) {
    args.push("-c", `model_reasoning_effort="${input.options.reasoningEffort}"`);
  }
  if (input.options.reasoningSummary) {
    args.push("-c", `model_reasoning_summary="${input.options.reasoningSummary}"`);
  }
  if (input.options.verbosity) {
    args.push("-c", `model_verbosity="${input.options.verbosity}"`);
  }
  args.push("--cd", input.cwd);
  args.push("--sandbox", input.options.sandbox ?? "workspace-write");
  if (input.options.skipGitRepoCheck) {
    args.push("--skip-git-repo-check");
  }
  if (input.options.ephemeral) {
    args.push("--ephemeral");
  }
  args.push(input.task);
  return args;
}

function codexRunOptions(metadata: Record<string, unknown>): CodexRunOptions {
  return {
    reasoningEffort: enumValue(metadata.reasoningEffort, ["minimal", "low", "medium", "high", "xhigh"]),
    reasoningSummary: enumValue(metadata.reasoningSummary, ["auto", "concise", "detailed", "none"]),
    verbosity: enumValue(metadata.verbosity, ["low", "medium", "high"]),
    sandbox: enumValue(metadata.sandbox, ["read-only", "workspace-write", "danger-full-access"]),
    skipGitRepoCheck: metadata.skipGitRepoCheck === true,
    ephemeral: metadata.ephemeral === true
  };
}

function enumValue<const T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  if (!allowed.includes(value as T)) {
    throw new Error(`Unsupported Codex option value: ${value}`);
  }
  return value as T;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
```

- [ ] **Step 4: Run adapter tests**

Run: `pnpm --filter @switchyard/adapters test -- codex-exec-json-adapter`

Expected: PASS.

- [ ] **Step 5: Run package checks**

Run: `pnpm --filter @switchyard/adapters typecheck && pnpm --filter @switchyard/adapters test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/adapters
git commit -m "feat: add codex exec json adapter"
```

## Task 5: Preserve Codex Metadata And Unsupported Input Responses

**Files:**
- Modify: `packages/protocol-rest/src/run-routes.ts`
- Modify: `packages/protocol-rest/test/run-routes.test.ts`

- [ ] **Step 1: Add route tests**

Append tests to `packages/protocol-rest/test/run-routes.test.ts` near the other run creation/input tests:

```ts
  it("preserves provider-specific run metadata", async () => {
    const harness = createRouteHarness();

    const createResponse = await harness.app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        ...fakeRunPayload("Codex metadata run"),
        runtime: "codex",
        provider: "openai",
        model: "gpt-5.5",
        metadata: {
          reasoningEffort: "high",
          reasoningSummary: "auto",
          verbosity: "low"
        }
      }
    });

    const run = createResponse.json().run;
    expect(run.metadata).toMatchObject({
      reasoningEffort: "high",
      reasoningSummary: "auto",
      verbosity: "low"
    });
  });

  it("returns conflict when runtime input is unsupported", async () => {
    const harness = createRouteHarness();
    const unsupported = new Error("Codex exec-json does not support input after start");
    unsupported.name = "CodexInputUnsupportedError";
    vi.spyOn(harness.runService, "sendInput").mockRejectedValueOnce(unsupported);
    const created = await harness.app.inject({
      method: "POST",
      url: "/runs",
      payload: fakeRunPayload("Unsupported input run")
    });

    const response = await harness.app.inject({
      method: "POST",
      url: `/runs/${created.json().run.id}/input`,
      payload: { text: "continue" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: "adapter_protocol_failed",
        message: "Codex exec-json does not support input after start"
      }
    });
  });
```

- [ ] **Step 2: Run failing route tests**

Run: `pnpm --filter @switchyard/protocol-rest test -- run-routes`

Expected: FAIL because unsupported input is not mapped to `409`.

- [ ] **Step 3: Map unsupported input in route**

Modify the `/runs/:id/input` handler in `packages/protocol-rest/src/run-routes.ts`:

```ts
  app.post("/runs/:id/input", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const run = await deps.runs.get(id);
    if (!run) {
      return reply.code(404).send({ error: { code: "run_not_found", message: `Run not found: ${id}` } });
    }

    try {
      await deps.runService.sendInput(id, inputBody(request.body));
    } catch (error) {
      if (isUnsupportedInputError(error)) {
        return reply.code(409).send({
          error: {
            code: "adapter_protocol_failed",
            message: error instanceof Error ? error.message : String(error)
          }
        });
      }
      throw error;
    }
    return reply.code(202).send({ accepted: true });
  });
```

Add this helper near the bottom of the file:

```ts
function isUnsupportedInputError(error: unknown): boolean {
  return error instanceof Error && error.name === "CodexInputUnsupportedError";
}
```

- [ ] **Step 4: Run route tests**

Run: `pnpm --filter @switchyard/protocol-rest test -- run-routes`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol-rest/src/run-routes.ts packages/protocol-rest/test/run-routes.test.ts
git commit -m "feat: handle unsupported runtime input"
```

## Task 6: Wire Codex Into The Daemon Registry And Adapter Map

**Files:**
- Modify: `apps/daemon/package.json`
- Modify: `apps/daemon/src/app.ts`
- Modify: `apps/daemon/test/smoke.test.ts`

- [ ] **Step 1: Add daemon dependency**

Modify `apps/daemon/package.json` dependencies:

```json
"@switchyard/adapters": "workspace:*",
```

- [ ] **Step 2: Add daemon smoke test for Codex registry**

Append to `apps/daemon/test/smoke.test.ts`:

```ts
  it("exposes Codex runtime registry records", async () => {
    const app = await createDaemonApp();
    try {
      const provider = await app.inject({ method: "GET", url: "/providers/provider_openai" });
      const runtime = await app.inject({ method: "GET", url: "/runtimes/runtime_codex" });

      expect(provider.statusCode).toBe(200);
      expect(provider.json().provider).toMatchObject({
        id: "provider_openai",
        name: "OpenAI",
        authMode: "local"
      });
      expect(runtime.statusCode).toBe(200);
      expect(runtime.json().runtime).toMatchObject({
        id: "runtime_codex",
        name: "Codex",
        adapterType: "process"
      });
    } finally {
      await app.close();
    }
  });
```

- [ ] **Step 3: Run failing daemon test**

Run: `pnpm --filter @switchyard/daemon test -- smoke`

Expected: FAIL because Codex registry records are not seeded.

- [ ] **Step 4: Wire adapter and registry seeding**

Modify imports in `apps/daemon/src/app.ts`:

```ts
import { CodexExecJsonAdapter, probeCodexCatalog } from "@switchyard/adapters";
```

Replace adapter map construction:

```ts
  const codexProbe = await probeCodexCatalog();
  const adapters = new Map([
    ["fake", new FakeRuntimeAdapter()],
    ["codex", new CodexExecJsonAdapter({ modelCatalog: codexProbe.models })]
  ]);
```

Change registry seeding:

```ts
    await seedFakeRegistry(stores.registry);
    await seedCodexRegistry(stores.registry, codexProbe);
```

Add this function below `seedFakeRegistry`:

```ts
async function seedCodexRegistry(registry: RegistryStore, probe: Awaited<ReturnType<typeof probeCodexCatalog>>): Promise<void> {
  if (!(await registry.getProvider("provider_openai"))) {
    await registry.createProvider({
      id: "provider_openai",
      name: "OpenAI",
      authMode: "local",
      status: probe.ok ? "available" : "unavailable"
    });
  }
  if (!(await registry.getRuntime("runtime_codex"))) {
    await registry.createRuntime({
      id: "runtime_codex",
      name: "Codex",
      adapterType: "process",
      status: probe.ok ? "available" : "unavailable"
    });
  }
  for (const model of probe.models) {
    const id = `model_${model.slug.replaceAll(".", "_").replaceAll("-", "_")}`;
    if (!(await registry.getModel(id))) {
      await registry.createModel({
        id,
        providerId: "provider_openai",
        modelName: model.slug,
        supportsTools: true,
        supportsStreaming: true,
        supportsBrowser: false,
        status: "available"
      });
    }
  }
}
```

- [ ] **Step 5: Run daemon tests**

Run: `pnpm --filter @switchyard/daemon test -- smoke`

Expected: PASS whether or not the local Codex catalog is available; provider/runtime records should exist, model records only exist when `codex debug models` succeeds.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/package.json apps/daemon/src/app.ts apps/daemon/test/smoke.test.ts
git commit -m "feat: register codex daemon runtime"
```

## Task 7: Add Optional Live Codex Probe Documentation

**Files:**
- Create: `docs/adapters/verification/codex-exec-json.md`

- [ ] **Step 1: Run a harmless live local probe manually**

Run only when the user approves spending local Codex usage:

```bash
codex exec --json \
  --model gpt-5.5 \
  -c model_reasoning_effort=\"low\" \
  --cd /Users/vasuyadav/Downloads/Projects/switchyard \
  --sandbox read-only \
  "Return one sentence describing this repository. Do not edit files."
```

Expected: JSONL events on stdout containing `thread.started`, `turn.started`, `item.*`, and either `turn.completed` or `turn.failed`.

- [ ] **Step 2: Save verification notes**

Create `docs/adapters/verification/codex-exec-json.md`:

```md
# Codex Exec JSON Verification

Date: 2026-05-14

Command:

```bash
codex exec --json --model gpt-5.5 -c model_reasoning_effort=\"low\" --cd /Users/vasuyadav/Downloads/Projects/switchyard --sandbox read-only "Return one sentence describing this repository. Do not edit files."
```

Observed event types:

- thread.started
- turn.started
- item.*
- turn.completed

Adapter notes:

- Stdout is JSONL and suitable for line-by-line parsing.
- Stderr should be preserved in the transcript artifact for diagnostics.
- Non-interactive mode does not support mid-run input; Switchyard returns 409 for input attempts.
```

- [ ] **Step 3: Commit**

```bash
git add docs/adapters/verification/codex-exec-json.md
git commit -m "docs: verify codex exec json surface"
```

## Task 8: Update Changelog And Full Verification

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update changelog**

Add under `## 0.1.0 - 2026-05-11` / `### Added`:

```md
- Added `@switchyard/adapters` with a Codex `exec --json` runtime adapter, local model catalog discovery, JSONL event normalization, transcript artifact capture, and daemon registry wiring.
```

- [ ] **Step 2: Run focused package checks**

Run:

```bash
pnpm --filter @switchyard/adapters test
pnpm --filter @switchyard/adapters typecheck
pnpm --filter @switchyard/protocol-rest test
pnpm --filter @switchyard/daemon test
```

Expected: all PASS.

- [ ] **Step 3: Run full workspace verification**

Run:

```bash
pnpm test
pnpm typecheck
```

Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: record codex provider slice"
```

## Self-Review

Spec coverage:

- Codex exec-json only: covered by Tasks 3, 4, and 6.
- Model and reasoning configuration: covered by Tasks 2 and 4.
- Local catalog as source of truth: covered by Tasks 2 and 6.
- Raw transcript artifact: covered by Task 4.
- Unsupported input response: covered by Task 5.
- No CI live Codex dependency: covered by fake process tests in Task 4 and optional live probe in Task 7.

Placeholder scan:

- No `TBD`, `TODO`, or "implement later" placeholders remain.
- The optional live probe is explicitly marked user-approved/manual and is not part of normal verification.

Type consistency:

- `CodexRunOptions`, `CodexModelCatalogEntry`, and `CodexExecJsonAdapter` are defined before use.
- Route tests use `CodexInputUnsupportedError` by `name` only, avoiding a protocol-rest dependency on adapters.
- Daemon depends on adapters at the app edge; core and protocol packages remain adapter-agnostic.
