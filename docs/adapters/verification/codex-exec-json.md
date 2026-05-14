# Codex Exec JSON Verification

Date: 2026-05-14

## Local CLI Surface

Verified locally without running a model task:

```bash
codex --version
codex exec --help
codex debug models
```

Observed:

- Codex CLI version: `codex-cli 0.130.0`
- `codex exec` supports `--json`, `--model`, `--cd`, `--sandbox`, `--skip-git-repo-check`, `--ephemeral`, and `-c key=value` config overrides.
- Local Codex config uses `model` and `model_reasoning_effort`.
- `codex debug models` returns a JSON model catalog with model slugs, default reasoning level, supported reasoning levels, reasoning summary support, and verbosity support.

Observed local model slugs included:

- `gpt-5.5`
- `gpt-5.4`
- `gpt-5.4-mini`
- `gpt-5.3-codex`
- `gpt-5.3-codex-spark`
- `gpt-5.2`
- `codex-auto-review`

## Manual Live Probe

This command intentionally runs a real Codex model task and may spend local Codex usage. Run it only with explicit approval.

```bash
codex exec --json \
  --model gpt-5.5 \
  -c model_reasoning_effort=\"low\" \
  --cd /Users/vasuyadav/Downloads/Projects/switchyard \
  --sandbox read-only \
  "Return one sentence describing this repository. Do not edit files."
```

Expected event shape:

- `thread.started`
- `turn.started`
- `item.*`
- `turn.completed` or `turn.failed`

Adapter notes:

- Stdout should be parsed as JSONL.
- Stderr should be preserved in the transcript artifact for diagnostics.
- Non-interactive mode does not support mid-run input; Switchyard returns `409` for input attempts.
- CI-safe tests must use fake process fixtures and must not call the real Codex CLI.

