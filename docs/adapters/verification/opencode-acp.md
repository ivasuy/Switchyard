# OpenCode ACP Verification

## Local Version

```text
opencode 1.3.15
```

## Result

`opencode acp` successfully handled:

- `initialize`
- `session/new`

The initialize response included ACP protocol version, capabilities, auth methods, and OpenCode agent info. `session/new` returned a `ses_...` session id and current model.

## Not Run

`session/prompt` was not executed because it could spend model budget.

## Decision

OpenCode remains the first real adapter candidate once `packages/protocol-acpx` exists.
