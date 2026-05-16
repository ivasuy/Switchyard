# Official API Contract

This is the current local daemon API contract. It documents what an app can call today.

Base URL:

```text
http://127.0.0.1:4545
```

Current implementation status:

- Implemented: health, runs, run events, run artifacts, run input, run cancellation, single-record registry lookups.
- Implemented runtime: local Codex through `codex exec --json`, plus the fake test runtime.
- Not implemented yet: run listing, trace endpoint, OpenAPI generation, debates, approvals, memory, tools, artifact-by-id, hosted workers, dashboards, TUI, open-ended live SSE.

## Status Codes

Common success responses:

| Status | Meaning |
| --- | --- |
| `200` | Query succeeded. |
| `201` | Run was created and completed synchronously through `wait=1`. |
| `202` | Run was accepted and launched asynchronously, or input was accepted. |
| `404` | Requested run, provider, runtime, or model was not found. |
| `409` | Request is valid, but the selected adapter cannot perform it. Codex `exec --json` returns this for post-start input. |

## Run Object

```json
{
  "id": "run_...",
  "runtime": "codex",
  "provider": "openai",
  "model": "gpt-5.5",
  "adapterType": "process",
  "cwd": "/Users/example/project",
  "task": "Return one sentence describing this repository.",
  "status": "completed",
  "placement": "local",
  "approvalPolicy": "default",
  "timeoutSeconds": 120,
  "metadata": {},
  "createdAt": "2026-05-14T15:53:28.542Z",
  "startedAt": "2026-05-14T15:53:28.543Z",
  "endedAt": "2026-05-14T15:53:49.249Z"
}
```

Run statuses:

```text
queued
starting
running
waiting_for_input
waiting_for_approval
completed
failed
cancelled
timeout
```

Adapter types:

```text
native
acpx
http
webhook
process
pty
browser
```

## Response Summary

`POST /runs?wait=1` returns a compact response summary in addition to the run.

```json
{
  "response": {
    "text": "Switchyard is a TypeScript monorepo...",
    "outputs": [
      {
        "sequence": 16,
        "text": "Switchyard is a TypeScript monorepo..."
      }
    ]
  }
}
```

Rules:

- `response.text` is the last normalized `runtime.output` text, usually the final visible model answer.
- `response.outputs` contains every normalized text output event.
- `outputs[].sequence` is the global run event sequence, not a contiguous output index. Gaps mean non-output events occurred between output events.
- Async `POST /runs` does not include `response`; fetch `/runs/:id` or `/runs/:id/events`.

## Event Object

```json
{
  "id": "event_...",
  "type": "runtime.output",
  "runId": "run_...",
  "sequence": 4,
  "payload": {
    "text": "I found a TypeScript monorepo...",
    "codexType": "item.completed"
  },
  "createdAt": "2026-05-14T15:53:35.000Z"
}
```

Current event types include:

```text
run.queued
run.started
runtime.status
runtime.output
artifact.created
run.completed
run.cancelled
run.failed
```

The contract allows more event types than the current local Codex path emits.

## Health

```bash
curl -s http://127.0.0.1:4545/health
```

Response:

```json
{"ok":true}
```

## Create Async Run

Use this when your app wants to start work and inspect progress later.

```bash
curl -s -X POST "http://127.0.0.1:4545/runs" \
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

Response:

```json
{
  "run": {
    "id": "run_...",
    "status": "queued"
  }
}
```

The daemon launches the run in the background.

## Create And Wait

Use this when your app wants one blocking request and the final model answer.

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
      "sandbox": "read-only",
      "ignoreUserConfig": true
    },
    "timeoutSeconds": 120
  }'
```

Response shape:

```json
{
  "run": {
    "id": "run_...",
    "status": "completed"
  },
  "response": {
    "text": "Switchyard is a TypeScript monorepo for a deploy-anywhere agent runtime gateway...",
    "outputs": [
      {
        "sequence": 16,
        "text": "Switchyard is a TypeScript monorepo for a deploy-anywhere agent runtime gateway..."
      }
    ]
  }
}
```

`POST /runs?wait=1` is not streamed. It returns one JSON response when the run reaches a terminal state.

## Get Run

```bash
RUN_ID=run_replace_me
curl -s "http://127.0.0.1:4545/runs/$RUN_ID"
```

Response:

```json
{
  "run": {},
  "events": []
}
```

Use this for complete JSON event inspection. It returns every persisted event.

## Get Run Events

```bash
RUN_ID=run_replace_me
curl -s "http://127.0.0.1:4545/runs/$RUN_ID/events"
```

Response content type:

```text
text/event-stream; charset=utf-8
```

The response is Server-Sent Events formatted replay:

```text
event: runtime.output
data: {"id":"event_...","type":"runtime.output","runId":"run_...","sequence":4,"payload":{"text":"..."},"createdAt":"..."}
```

Bounded live mode:

```bash
RUN_ID=run_replace_me
curl -N "http://127.0.0.1:4545/runs/$RUN_ID/events?live=1&stopAfter=20"
```

Current limitation: live mode is bounded by `stopAfter`; it is not an open-ended stream yet.

## Get Run Artifacts

```bash
RUN_ID=run_replace_me
curl -s "http://127.0.0.1:4545/runs/$RUN_ID/artifacts"
```

Response:

```json
{
  "artifacts": [
    {
      "id": "artifact_...",
      "runId": "run_...",
      "type": "transcript",
      "path": "runs/run_.../transcript.jsonl",
      "metadata": {
        "contentStored": true
      },
      "createdAt": "2026-05-14T15:53:49.000Z"
    }
  ]
}
```

Artifact content is stored locally by the daemon. There is no `GET /artifacts/:id` endpoint yet.

## Send Input

```bash
RUN_ID=run_replace_me
curl -s -X POST "http://127.0.0.1:4545/runs/$RUN_ID/input" \
  -H 'content-type: application/json' \
  -d '{"text":"continue"}'
```

Success response:

```json
{"accepted":true}
```

Codex `exec --json` limitation:

```json
{
  "error": {
    "code": "adapter_protocol_failed",
    "message": "Codex exec-json does not support input after start"
  }
}
```

Use Codex `exec --json` as a one-shot non-interactive run mode.

## Cancel Run

```bash
RUN_ID=run_replace_me
curl -s -X POST "http://127.0.0.1:4545/runs/$RUN_ID/cancel"
```

Response:

```json
{
  "run": {
    "id": "run_...",
    "status": "cancelled"
  }
}
```

## Registry Lookups

Provider:

```bash
curl -s http://127.0.0.1:4545/providers/provider_openai
```

Runtime:

```bash
curl -s http://127.0.0.1:4545/runtimes/runtime_codex
```

Model:

```bash
curl -s http://127.0.0.1:4545/models/model_gpt_5_5
```

Current limitation: list endpoints are not implemented yet. Use known seeded IDs.

## Codex Metadata

Current Codex metadata keys:

| Key | Example | Notes |
| --- | --- | --- |
| `reasoningEffort` | `"low"` | Validated against the local model catalog when available. |
| `reasoningSummary` | `"auto"` | Passed through to Codex config overrides. |
| `verbosity` | `"low"` | Passed through to Codex config overrides. |
| `sandbox` | `"read-only"` | Passed to `codex exec --sandbox`. |
| `ignoreUserConfig` | `true` | Defaults to `true` for daemon-launched Codex runs. |
| `ignoreRules` | `false` | Defaults to `false`. |

See [Codex Adapter Local Development](adapters/CODEX.md) for Codex-specific logs, PID checks, and stuck-run diagnosis.
