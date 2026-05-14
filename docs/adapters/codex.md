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
- `codex exec` exposes `--json`, `--model`, `--cd`, `--sandbox`, `--skip-git-repo-check`, `--ephemeral`, and `-c key=value`.
- `codex debug models` returns local model slugs and supported reasoning levels.
- Live `codex exec --json` probe was deferred to avoid spend and unintended workspace changes.

## Implementation Notes

- `@switchyard/adapters` includes `CodexExecJsonAdapter`.
- Model and reasoning configuration are read from run metadata and mapped to Codex CLI args.
- The adapter validates requested reasoning effort against the local model catalog when available.
- JSONL stdout is normalized to Switchyard events.
- Raw stdout JSONL plus stderr are preserved as transcript artifacts.
- `POST /runs/:id/input` is unsupported for this mode and returns `409`.
- CI-safe tests use fake process fixtures and do not call the real Codex CLI.

## Local Run Example

```bash
curl -s -X POST "http://127.0.0.1:4545/runs?wait=1" \
  -H 'content-type: application/json' \
  -d '{
    "runtime": "codex",
    "provider": "openai",
    "model": "gpt-5.5",
    "adapterType": "process",
    "cwd": "/Users/vasuyadav/Downloads/Projects/switchyard",
    "task": "Return one sentence describing this repository. Do not edit files.",
    "metadata": {
      "reasoningEffort": "low",
      "reasoningSummary": "auto",
      "verbosity": "low",
      "sandbox": "read-only"
    }
  }'
```

Focused local verification:

```bash
pnpm --filter @switchyard/adapters test
pnpm --filter @switchyard/daemon test
```

## Status

Implemented for non-interactive local `codex exec --json` runs. Interactive sessions, approval bridging, PTY support, and hosted process execution are not implemented yet.
