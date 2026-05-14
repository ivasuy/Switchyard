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
- `codex exec` supports `--json`, `--model`, `--cd`, `--sandbox`, `--skip-git-repo-check`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, and `-c key=value` config overrides.
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

## Manual Live Probe Command

This command intentionally runs a real Codex model task and may spend local Codex usage. Run it only with explicit approval.

```bash
codex exec --json \
  --model gpt-5.5 \
  -c model_reasoning_effort=\"low\" \
  --cd /Users/vasuyadav/Downloads/Projects/switchyard \
  --sandbox read-only \
  --ignore-user-config \
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
- Daemon-launched runs default to `--ignore-user-config`; set metadata `ignoreUserConfig: false` to reproduce a full local Codex config run.
- If Codex starts but never emits JSONL, Switchyard should log the process id and mark the run `timeout` at `timeoutSeconds`.
- CI-safe tests must use fake process fixtures and must not call the real Codex CLI.

## Switchyard Live Probe

Verified on 2026-05-14 with an isolated daemon on port `4546`:

```bash
curl -s -X POST "http://127.0.0.1:4546/runs?wait=1" \
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
      "sandbox": "read-only",
      "ignoreUserConfig": true
    },
    "timeoutSeconds": 120
  }'
```

Observed:

- Run status: `completed`
- `codex.spawned` logged a child process id.
- Codex wrote `Reading additional input from stdin...` to stderr, then emitted `codex.stdout.first_line` immediately because the adapter closed stdin.
- Events included `thread.started`, `turn.started`, `runtime.output`, `run.completed`, and `artifact.created`.
- Transcript artifact metadata reported `contentStored: true`.
