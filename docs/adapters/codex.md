# Codex Adapter

## Target

Codex should support coding/repo tasks through a structured headless path; PTY fallback is not shipped.

## Preferred Protocol

- Primary: `codex exec --json` through the process adapter. This is `codex.exec_json` and remains one-shot.
- Secondary (shipped in R16): explicit local-only `codex.interactive` mode under the same runtime adapter contract.
- Last resort: PTY is not shipped; no public PTY/terminal route exists.

## Verified Local Facts

- Binary: `/opt/homebrew/bin/codex`
- Version: `codex-cli 0.130.0`
- `codex exec` exposes `--json`, `--model`, `--cd`, `--sandbox`, `--skip-git-repo-check`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, and `-c key=value`.
- `codex debug models` returns local model slugs and supported reasoning levels.
- Live `codex exec --json` through Switchyard completed locally on 2026-05-14 with `gpt-5.5`, `reasoningEffort: low`, `sandbox: read-only`, and `ignoreUserConfig: true`.
- Local no-spend interactive checks verify command-shape support for `codex exec --help --json` and `codex exec resume --help --json`.

## Implementation Notes

- `@switchyard/adapters` includes `CodexExecJsonAdapter`.
- Model and reasoning configuration are read from run metadata and mapped to Codex CLI args.
- The adapter validates requested reasoning effort against the local model catalog when available.
- JSONL stdout is normalized to Switchyard events.
- Raw stdout JSONL plus stderr are preserved as transcript artifacts.
- `POST /runs/:id/input` is unsupported for this mode and returns `409`.
- `codex.interactive` supports post-start input when explicitly selected and when a resume token (`codexThreadId`) is present.
- `codex.interactive` approval bridge support is conditional on driver capability; no-spend checks report command-shape capability separately from live resume verification.
- Daemon logs include run id, process id, stderr snippets, first stdout detection, terminal state, and timeout state.
- `ignoreUserConfig` defaults to `true` to keep daemon-launched Codex jobs isolated from local interactive config such as MCP servers; set it to `false` per run when that config is required.
- Run-level `timeoutSeconds` is enforced by the runner so a process that never emits JSONL is terminalized as `timeout` instead of remaining `running`.
- CI-safe tests use fake process fixtures and do not call the real Codex CLI.

## Hosted Debate Boundary

- R24 allows `codex.exec_json` as an opt-in local/hosted debate participant runtime.
- `codex.exec_json` remains one-shot; each debate turn is a normal bounded child run, not a resumed interactive session.
- Hosted input and approval bridges are unsupported for `codex.exec_json`.
- Hosted `codex.interactive`, hosted Codex live-resume, public PTY/terminal routes, and PTY/TUI automation remain unshipped.

## Local Development

For prebuilt local curls, focused verification commands, PID checks, SQLite queries, and stuck-state interpretation, see [Codex Adapter Local Development](../development/adapters/CODEX.md).

## Status

Implemented for `codex.exec_json` one-shot runs and explicit local-only `codex.interactive` runs. R24 hosted debate may use `codex.exec_json` only as an opt-in one-shot participant. Hosted `codex.interactive`, hosted Codex live-resume, hosted post-start input/approval for Codex, public PTY/terminal routes, PTY/TUI automation, and managed hosted Codex execution remain unshipped.
