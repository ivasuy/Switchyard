# Codex Verification

## Local Version

```text
codex 0.130.0
```

## Result

The local Codex CLI exists and is detected by the Codex adapter catalog probe.

## Not Run

`codex exec --json` was not executed because it could spend model budget or modify workspace state.

## Decision

The non-interactive Codex adapter is implemented through `codex exec --json` using fake-process parser fixtures for CI-safe coverage. See `docs/adapters/verification/codex-exec-json.md` for the optional live probe command.
