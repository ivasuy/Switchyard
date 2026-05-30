# Codex Adapter

## Target

Codex should support coding/repo tasks through a structured headless path before any PTY fallback.

## Preferred Protocol

- Primary: `codex exec --json` through the local process adapter.
- Future: interactive process/PTY mode after the non-interactive path is stable.
- Last resort: PTY, local-only by policy.

## Verified Local Facts

- Binary: `/opt/homebrew/bin/codex`
- Version: `codex-cli 0.130.0`
- `codex exec` exposes `--json`, `--model`, `--cd`, `--sandbox`, `--skip-git-repo-check`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, and `-c key=value`.
- `codex debug models` returns local model slugs and supported reasoning levels.
- Live `codex exec --json` through Switchyard completed locally on 2026-05-14 with `gpt-5.5`, `reasoningEffort: low`, `sandbox: read-only`, and `ignoreUserConfig: true`.

## Implementation Notes

- `@switchyard/adapters` includes `CodexExecJsonAdapter`.
- Model and reasoning configuration are read from run metadata and mapped to Codex CLI args.
- The adapter validates requested reasoning effort against the local model catalog when available.
- JSONL stdout is normalized to Switchyard events.
- Raw stdout JSONL plus stderr are preserved as transcript artifacts.
- `POST /runs/:id/input` is unsupported for this mode and returns `409`.
- Daemon logs include run id, process id, stderr snippets, first stdout detection, terminal state, and timeout state.
- `ignoreUserConfig` defaults to `true` to keep daemon-launched Codex jobs isolated from local interactive config such as MCP servers; set it to `false` per run when that config is required.
- Run-level `timeoutSeconds` is enforced by the runner so a process that never emits JSONL is terminalized as `timeout` instead of remaining `running`.
- CI-safe tests use fake process fixtures and do not call the real Codex CLI.

## Local Development

For prebuilt local curls, focused verification commands, PID checks, SQLite queries, and stuck-state interpretation, see [Codex Adapter Local Development](../development/adapters/CODEX.md).

## Status

Implemented for non-interactive local `codex exec --json` runs. Post-start input, approval bridging, PTY support, and hosted process execution are not implemented. Codex interactive/resume runtime promotion remains deferred in R8.
