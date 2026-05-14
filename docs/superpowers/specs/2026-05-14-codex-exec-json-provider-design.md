# Codex Exec-JSON Provider Design

## Goal

Add Codex as the first real bottom-up provider slice for Switchyard. The first supported mode is non-interactive local execution through `codex exec --json`; interactive sessions, PTY control, approval bridging, and multi-turn steering are intentionally deferred.

## Runtime Shape

Clients create a normal Switchyard run with:

```json
{
  "runtime": "codex",
  "provider": "openai",
  "model": "gpt-5.5",
  "adapterType": "process",
  "cwd": "/repo",
  "task": "Summarize this repository",
  "metadata": {
    "reasoningEffort": "high",
    "reasoningSummary": "auto",
    "verbosity": "low",
    "sandbox": "workspace-write"
  }
}
```

Switchyard launches:

```bash
codex exec --json \
  --model gpt-5.5 \
  -c model_reasoning_effort=\"high\" \
  -c model_reasoning_summary=\"auto\" \
  -c model_verbosity=\"low\" \
  --cd /repo \
  --sandbox workspace-write \
  "Summarize this repository"
```

The adapter never invokes a shell. It uses an argv array so prompts, paths, and config values are not shell-expanded.

## Model And Reasoning Configuration

The Codex adapter treats the local Codex install as the source of truth for model availability. `codex debug models` is parsed at daemon startup and during adapter checks. Returned model slugs, default reasoning level, supported reasoning levels, verbosity support, and reasoning summary support are exposed through adapter check details and seeded into the registry where possible.

The first implementation accepts these run metadata keys:

- `reasoningEffort`: `minimal`, `low`, `medium`, `high`, or `xhigh`; validated against the selected local model when a catalog is available.
- `reasoningSummary`: `auto`, `concise`, `detailed`, or `none`.
- `verbosity`: `low`, `medium`, or `high`.
- `sandbox`: `read-only`, `workspace-write`, or `danger-full-access`; defaults to `workspace-write`.
- `skipGitRepoCheck`: boolean; maps to `--skip-git-repo-check`.
- `ephemeral`: boolean; maps to `--ephemeral`.

The first adapter does not hard-code model slugs as validation truth. Documentation and local probes currently show `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`, and `gpt-5.2`, but availability must come from `codex debug models` for the running account and CLI version.

## Event Mapping

`codex exec --json` writes JSONL to stdout. Switchyard stores the raw stream as a transcript artifact and maps known events into normalized Switchyard events:

- `thread.started` and `turn.started` become `runtime.status`.
- `item.*` events become `runtime.output` when text can be extracted; otherwise they become `runtime.status` with the original Codex event type in payload.
- command/tool-like item events may become `tool.call` or `tool.result` once the real fixture shape is captured, but this is not required for the first working slice.
- `turn.completed` becomes `run.completed`.
- `turn.failed`, top-level `error`, parser failures, spawn failures, and non-zero process exits become `run.failed`.

Every normalized payload keeps enough Codex metadata to debug the original event without bloating the run event stream. The complete raw JSONL remains in the transcript artifact.

## Adapter Behavior

`CodexExecJsonAdapter.check()` verifies the `codex` binary, captures `codex --version`, and attempts `codex debug models`. A missing binary returns `ok: false`; a missing catalog returns `ok: true` only if the version probe succeeds, with catalog details marked unavailable.

`start()` spawns one local process and stores it under an adapter-owned session id. `events()` streams parsed stdout lines until a terminal event or process exit. `cancel()` terminates the process. `send()` throws a typed unsupported-input error because exec-json is not interactive.

`artifacts()` returns one transcript artifact with metadata content containing raw JSONL plus stderr. RuntimeRunnerService already persists artifact content when an artifact content store is configured.

## Boundaries

This slice creates `packages/adapters` and wires only the local daemon to Codex. It does not add hosted workers, a generic process runtime abstraction, UI, SDK changes, or interactive Codex sessions. Shared subprocess helpers can be extracted after a second real process-backed provider proves the common shape.

## Testing

The plan should cover parser tests from stable fixtures, adapter tests with fake spawned processes, daemon registry seeding tests, REST metadata pass-through tests, and one optional live local smoke command that spends Codex usage only when explicitly run.

The normal CI-safe test suite must not call the real Codex CLI.
