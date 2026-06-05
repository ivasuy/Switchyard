# Phase 16 Spec: R17 Production Tools And Adapter Expansion

**Date:** 2026-05-30
**Run:** `post-r11-remaining-20260530`
**Branch:** `agent/phase-16-r17-production-tools-and-adapter-expansion`
**Spec target:** `docs/superpowers/specs/2026-05-30-phase-16-r17-production-tools-and-adapter-expansion.md`

## Problem

Switchyard has real runtime execution for known local modes, explicit local Codex interaction, fake/no-spend hosted sandbox contracts, middleware tool records, approvals, and connected-node policy primitives. The remaining release gap is tool execution: the public tool surface already names real tools, but the core still denies every real tool before adapter dispatch. Users can orchestrate runs and approvals, but they cannot safely perform basic production actions such as a bounded HTTP fetch, read-only GitHub lookup, read-only repo inspection, or allowlisted local command.

R17 should close the smallest useful production tool gap without turning Switchyard into a public shell, terminal, hosted process runner, or broad adapter-completion release. The safe slice is local-daemon only real tool execution for bounded, policy-gated, approval-mediated tools; deterministic fake/no-spend tests prove every data path; hosted arbitrary subprocess/PTY, browser automation, Cursor/OpenClaw/Paperclip, and runtime-specific wrapper approval bridges remain unshipped.

## Goals

- Ship a deny-by-default real tool execution layer behind the existing `/tools/invocations` API. No new `/exec`, `/shell`, `/process`, `/terminal`, `/pty`, `/sandbox`, `/browser`, or `/search` execution route is allowed.
- Enable a narrow local-daemon real tool set when explicitly configured: `fetch`, `web_search`, `github`, `repo`, and command-catalog `shell`.
- Keep `browser` denied in R17. A real browser adapter needs stronger isolation, visual artifact policy, JavaScript/network controls, and dependency/runtime verification than this phase should absorb.
- Require explicit operator configuration before any real tool can execute. Default behavior remains fake/no-spend: `fake_echo` works, every real tool is denied with a named reason and a persisted denied invocation.
- Require approval for every real tool invocation by default. Tool execution must not start until the approval is approved, and rejection/expiration must terminalize the invocation as `denied`.
- Bound every input, output, artifact, timeout, redirect, process, and network hop. Inline responses are summaries; large/raw output goes to bounded artifacts with truncation metadata.
- Redact secrets from request input, approval payloads, events, logs, invocation records, and artifact metadata. Raw artifact content must also be bounded and must redact known credential shapes where the adapter can observe them.
- Add a small internal local process foundation for `repo` and command-catalog `shell` tools. It must spawn binaries directly without shell interpolation and must not create a public generic process runtime mode.
- Keep connected-node real tool execution unshipped, but update node policy/product truth so connected-node capability claims do not imply real tool support. The current node app only emits synthetic execution unless an injected executor is supplied; R17 must not overclaim it.
- Keep hosted arbitrary subprocess/PTY execution unshipped. Hosted workers and hosted server processes must not execute real tools in R17.
- Preserve deterministic no-spend tests by using fake tool clients, local test HTTP servers, fake process factories, and fake GitHub/search clients.
- Update docs/product truth and OpenAPI boundary tests so the shipped surface is impossible to confuse with a managed hosted platform or arbitrary shell route.

## Non-Goals

- No dashboard.
- No TUI.
- No managed hosted production platform.
- No enterprise auth, billing, tenant isolation, organization controls, or role-based admin UI.
- No hosted arbitrary subprocess execution.
- No hosted PTY execution.
- No public `/sandbox`, `/exec`, `/pty`, `/terminal`, `/process`, `/shell`, `/command`, `/browser`, or `/search` execution routes.
- No public arbitrary shell command string. The `shell` tool accepts a configured `commandId`, not a raw command.
- No real browser automation adapter in R17.
- No generic process runtime mode.
- No generic PTY runtime mode.
- No `node-pty` dependency.
- No Cursor adapter.
- No OpenClaw adapter.
- No Paperclip adapter.
- No hosted Generic HTTP, AgentField, Cursor, OpenClaw, Paperclip, browser, search, fetch, GitHub, repo, or shell execution.
- No runtime-specific approval bridge expansion for OpenCode, AgentField, or Generic HTTP. Their unsupported bridge behavior must remain explicit until a later release verifies each runtime-side resolution contract with fake and real no-spend checks.
- No GitHub write operations, issue comments, PR creation, branch mutation, workflow dispatch, package publication, or repository network clone.
- No network fetches to private IP ranges, localhost, link-local, metadata-service addresses, or unallowlisted hosts.
- No live provider spend in required tests, default smoke, or default doctor checks.

## What Ships In R17

R17 ships local-daemon real tools only:

- `fetch`: HTTP(S) `GET` and `HEAD` only, allowlisted hosts only, bounded redirects, bounded response bytes, content-type policy, SSRF/private-network denial, artifact capture for response excerpts/content.
- `web_search`: optional configured search provider client with query/result bounds. Default is unavailable/denied; tests use fake clients. It returns metadata snippets and URLs, not full page content.
- `github`: read-only GitHub REST operations for allowlisted owner/repo pairs, with token from environment/config only and no token echo. Supported operations are deliberately small: get issue/PR metadata, list PR files, get repository file content by ref/path, and compare refs. No mutations.
- `repo`: read-only local repository inspection through an internal process executor. Supported operations are status, diff, show, ls-files, and grep with bounded pathspecs. No network, no mutation, no hooks, no package-manager execution.
- `shell`: command-catalog execution only. Operators configure named commands with absolute executable path, fixed argv template, allowed user arguments, cwd prefixes, timeout, output caps, and approval requirement. There is no raw command string and no shell interpolation.
- A shared policy/adapter dispatch foundation for real tools: deny-by-default config, allowlists, approval records, redacted policy traces, bounded event/artifact recording, fake clients, and no-spend tests.
- Documentation and contract truth updates for the R17 boundary.

## What Remains Unshipped

- `browser` remains a known tool type that policy denies before adapter dispatch with `browser_tool_unshipped`.
- Connected-node real tool execution remains unshipped. The node app may continue to enforce runtime/cwd/artifact sync policy and emit synthetic assignment results, but it must not advertise `tools.real` execution unless a future release adds a node-owned real tool executor and sync protocol.
- Hosted real tool execution remains unshipped. The hosted server does not register middleware tool routes today, and R17 must not add them.
- Hosted arbitrary subprocess/PTY remains unshipped. The R14 sandbox substrate remains fake/no-spend and must not be promoted to production process isolation.
- Cursor, OpenClaw, Paperclip, broad wrapper-runtime expansion, and runtime-specific approval bridges for OpenCode/AgentField/Generic HTTP remain unshipped.

## Current Truth

The existing contracts already expose real tool type names, but implementation does not execute them.

`packages/contracts/src/tool.ts`:

```ts
export const toolTypeSchema = z.enum(["web_search", "fetch", "browser", "repo", "shell", "github", "fake_echo"]);
export const toolInvocationStatusSchema = z.enum(["queued", "running", "completed", "failed", "cancelled", "denied"]);
```

The current local policy gate denies all real tool types. R17 replaces this hard-coded "not shipped" behavior with explicit configured policy, while preserving deny-by-default semantics.

`packages/core/src/services/local-policy-gate.ts`:

```ts
if (input.type !== "fake_echo") {
  return {
    decision: "deny" as const,
    reasonCode: "tool_policy_denied",
    policyTrace: [redactSecrets({ rule: "real_tools_not_shipped", ...baseTrace })]
  };
}
```

The current router also denies real tools before adapter dispatch and persists a denied invocation. R17 must preserve the "policy before adapter" ordering.

`packages/core/src/services/tool-router.ts`:

```ts
const REAL_TOOL_TYPES = new Set(["web_search", "fetch", "browser", "repo", "shell", "github"]);
const KNOWN_TOOL_TYPES = new Set([...REAL_TOOL_TYPES, "fake_echo"]);
```

```ts
if (REAL_TOOL_TYPES.has(input.type)) {
  const denied = await this.persistDeniedInvocation(input.runId, input.type as ToolInvocation["type"], normalizedInput, decision.policyTrace, "real tool execution is not available in R7");
  throw new ServiceError("tool_policy_denied", "Real tool execution is not shipped in R7", [
    { path: "toolInvocationId", issue: denied.id }
  ]);
}
```

The only existing public tool execution route is the generic invocation route. R17 must keep this as the only public tool execution boundary.

`packages/protocol-rest/src/middleware-routes.ts`:

```ts
app.post("/tools/invocations", async (request, reply) => {
  const body = ensureRecord(request.body, "Request body must be an object");
  const inputRaw = body["input"];
  if (!inputRaw || typeof inputRaw !== "object" || Array.isArray(inputRaw)) {
    return sendHttpError(reply, "invalid_input", "input must be an object", [{ path: "input", issue: "must be an object" }]);
  }
```

OpenAPI already guards against arbitrary execution routes. R17 must extend these checks, not weaken them.

`packages/contracts/src/openapi.contract.test.ts`:

```ts
it("keeps public arbitrary execution routes out of OpenAPI", () => {
  const document = generateOpenApiDocument();
  const forbiddenPathTokens = ["/sandbox", "/exec", "/pty", "/terminal", "/shell", "/process", "/command"];
  const paths = Object.keys(document.paths);
```

The R14 hosted sandbox substrate is explicitly fake/no-spend and deny-by-default for real commands. R17 must not convert this fake substrate into production hosted process execution.

`packages/contracts/src/sandbox.ts`:

```ts
export const SANDBOX_REAL_COMMAND_DENYLIST = [
  "sh",
  "bash",
  "zsh",
  "fish",
  "cmd",
  "powershell",
  "pwsh",
  "node",
  "python",
  "python3",
  "ruby",
  "perl",
  "go",
  "cargo",
  "npm",
  "pnpm",
  "yarn",
  "codex",
  "claude",
  "opencode",
  "git",
  "gh",
  "curl",
  "wget",
  "ssh",
  "scp",
  "browser",
  "web_search",
  "fetch",
  "repo",
  "github",
  "shell"
] as const;
```

Connected nodes already have a local policy service, but the node app does not execute real runtime adapters or tools by default.

`packages/core/src/services/local-node-policy-service.ts`:

```ts
if (!run.runtimeMode || !policy.allowRuntimeModes.includes(run.runtimeMode)) {
  return deny("node_policy_denied", [{ rule: "runtime_mode_denied", runtimeMode: run.runtimeMode ?? "unknown" }]);
}

if (policy.allowCwdPrefixes.length === 0 || !policy.allowCwdPrefixes.some((prefix) => run.cwd.startsWith(prefix))) {
  return deny("node_policy_denied", [{ rule: "cwd_denied", cwd: run.cwd }]);
}
```

`apps/node/src/app.ts`:

```ts
const execution = deps?.executeAssignment
  ? await deps.executeAssignment({ id: assignment.id, run })
  : createDefaultExecution(run, assignment.lastEventSequence);
```

Product truth after R16 says arbitrary shell/tool execution, generic process/PTY adapters, hosted tool execution, dashboard, and TUI remain unshipped. R17 may update that truth only for the exact local real tools listed above.

`PROJECT.md` Phase 15:

```md
The shipped boundary remains explicit: R16 does not ship hosted post-start input or approval bridges, public PTY/TUI/terminal/exec/sandbox routes, arbitrary shell/tool execution, generic process/PTY adapters, real shell/browser/search/GitHub/fetch/repo tools, live Codex resume success guarantees, hosted debate with real participant runtimes/model judging, managed production hosted platform deployment, enterprise auth/billing/tenant controls, dashboard, or TUI.
```

## Architecture

R17 keeps the existing middleware route shape and introduces a real-tool policy/adapter layer behind it:

```text
POST /tools/invocations
  -> validate request body/type/input bounds
  -> redact input
  -> require known run if runId is provided
  -> ToolPolicy decides deny | approval_required | allow
  -> denied: persist denied invocation, emit visible error
  -> approval_required: persist pending approval + queued invocation
  -> approve: revalidate policy from stored invocation, execute adapter once
  -> allow: execute adapter immediately only when policy explicitly permits it
  -> adapter: bounded execution, redacted logs/events, bounded artifacts
  -> terminal invocation: completed | failed | denied | cancelled
```

### Tool Policy

The policy layer must be deny-by-default at three levels:

- Global real tools default to disabled.
- Each tool type default is disabled.
- Each target default is denied until allowlisted.

Required resolved policy fields:

- `enabled`: global boolean. Default `false`.
- `allowedPlacements`: must be `["local"]` in R17. `hosted` and `connected_local_node` must be denied for real tools.
- `approvalDefault`: `required` for real tools.
- `approvalExpiresMs`: bounded positive value, default 300000.
- `maxConcurrentRealTools`: bounded integer, default 2 in local daemon.
- `maxInputBytes`: default 65536.
- `maxInlineOutputBytes`: default 32768.
- `maxArtifactBytes`: default 1048576.
- `defaultTimeoutMs`: default 30000, hard max 120000.
- `redactedSummary`: included in logs/doctor-like diagnostics without secrets.
- Per-tool allowlists for hosts, repos, cwd prefixes, command ids, operations, methods, content types, redirects, output size, and timeout.

The policy result must include:

- `decision`: `allow`, `approval_required`, or `deny`.
- `reasonCode`: stable named reason.
- `approvalType`: for queued approvals.
- `policyTrace`: redacted, low-cardinality, and safe to persist.
- `executionPlan`: adapter-specific plan that contains resolved command/URL/repo operation data. The adapter must use the plan, not raw untrusted request fields.

R17 must add `before_local_process_execution` to `approvalTypeSchema` for `repo` and `shell` approval payloads. Network tools must use the existing `before_external_web_action`.

### Real Tool Inputs

The public API remains one route, but each tool has a strict input shape:

`fetch`:

```json
{
  "type": "fetch",
  "input": {
    "url": "https://example.com/path",
    "method": "GET",
    "captureContent": true
  }
}
```

Rules:

- `url` is required, absolute, `http:` or `https:` only.
- Method is `GET` or `HEAD`; default `GET`.
- Request headers are denied by default; if supported, only configured header names are allowed and values are redacted when persisted.
- Redirects are bounded and must remain within allowed hosts/protocols.
- DNS/IP validation must deny private, loopback, link-local, multicast, metadata-service, and localhost destinations after redirect resolution.

`web_search`:

```json
{
  "type": "web_search",
  "input": {
    "query": "Switchyard runtime adapters",
    "maxResults": 5
  }
}
```

Rules:

- `query` is required, trimmed, non-empty, and bounded.
- `maxResults` is bounded between 1 and the configured max.
- The adapter uses an injected/configured provider client; default configuration is unavailable.
- Results contain title, URL, snippet, provider, and rank. No automatic fetch of result pages occurs.

`github`:

```json
{
  "type": "github",
  "input": {
    "operation": "get_issue",
    "owner": "openai",
    "repo": "codex",
    "number": 123
  }
}
```

Allowed operations:

- `get_issue`
- `get_pull`
- `list_pull_files`
- `get_file`
- `compare_refs`

Rules:

- Owner/repo must match configured allowlists.
- Token comes only from config/environment and is never accepted in request body.
- Mutating operations are denied even if the token would allow them.
- Response content is bounded; large file content is written as bounded artifact or denied by content-size policy.

`repo`:

```json
{
  "type": "repo",
  "input": {
    "operation": "diff",
    "cwd": "/repo",
    "pathspec": ["packages/core/src/services/tool-router.ts"]
  }
}
```

Allowed operations:

- `status`
- `diff`
- `show`
- `ls_files`
- `grep`

Rules:

- `cwd` must be absolute, normalized, and under a configured allowed prefix.
- Pathspecs must be relative, normalized, bounded, and must not contain traversal.
- Operations use fixed argv arrays and direct process spawn.
- No network flags, no writes, no checkout/reset/clean/apply/commit/push/fetch/pull/submodule operations.

`shell`:

```json
{
  "type": "shell",
  "input": {
    "commandId": "local.date.utc",
    "args": [],
    "cwd": "/repo"
  }
}
```

Rules:

- `commandId` is required and must match a configured catalog entry.
- Catalog entries specify absolute executable path, fixed argv template, user argument schema, cwd policy, env allowlist, timeout, stdout/stderr caps, and whether approval is always required.
- Raw command strings, shell metacharacter parsing, `sh -c`, inherited env, and user-supplied executable paths are forbidden.
- The default catalog is empty in non-test config.

`browser`:

- R17 policy denies before adapter dispatch with `browser_tool_unshipped`.
- The denied invocation is persisted with a redacted policy trace.

### Adapters

Adapters implement the existing `ToolAdapter` port where possible, but R17 should introduce typed internal adapter inputs so each adapter receives a resolved execution plan from policy. The public request body must not be passed straight through to a real adapter.

Required adapters:

- `FetchToolAdapter`
- `WebSearchToolAdapter`
- `GithubToolAdapter`
- `RepoToolAdapter`
- `ShellCatalogToolAdapter`
- existing `FakeEchoToolAdapter`

Required fake/no-spend clients:

- Fake fetch client with happy, redirect, private-IP, timeout, oversized, content-type, and upstream-failure paths.
- Fake search client with happy, zero results, provider timeout, provider error, and oversized result paths.
- Fake GitHub client with happy, not found, forbidden, rate limit, timeout, oversized payload, and missing token paths.
- Fake process factory with stdout, stderr, non-zero exit, timeout, cancellation, output flood, path traversal, and spawn error paths.

### Process Foundation

R17 must add a shared internal `LocalProcessToolExecutor` or equivalent utility for `repo` and command-catalog `shell` tools. It must:

- spawn binaries directly with argv arrays;
- never invoke a shell;
- close stdin unless the configured command explicitly needs bounded stdin, which R17 should avoid;
- enforce timeout through `AbortController` or process kill;
- capture stdout/stderr with byte caps and truncation markers;
- redact secrets from captured text before logs/events/metadata;
- expose process id only in debug logs if safe;
- return named errors for spawn, timeout, non-zero exit, output cap, cancellation, invalid cwd, invalid argv, and policy mismatch.

This foundation is not a generic process runtime adapter and must not be registered as a runtime mode.

### Approval Lifecycle

For every real tool, the default path is:

1. `POST /tools/invocations` validates input and computes policy.
2. Policy returns `approval_required`.
3. ToolRouter persists a queued invocation and a pending approval with redacted payload:
   - tool type;
   - invocation id;
   - reason code;
   - policy trace;
   - human-readable action summary;
   - `expiresAt`;
   - no raw secrets.
4. Router emits `approval.requested`.
5. `POST /approvals/:id/approve` atomically transitions the approval.
6. ToolRouter resolves the queued invocation exactly once, revalidates policy against the stored execution plan, executes the adapter, and emits one terminal `tool.result`.
7. `POST /approvals/:id/reject` terminalizes the queued invocation as `denied`.
8. Expiration terminalizes the queued invocation as `denied` with `approval_expired`.

Duplicate approve/reject calls must return `approval_not_pending` without duplicate adapter side effects.

### Events And Artifacts

Events:

- `tool.call` when execution starts.
- `tool.result` when execution completes, fails, is denied, expires, or is cancelled.
- `approval.requested`, `approval.approved`, `approval.rejected`, and `approval.expired` as applicable.

Tool result event payloads must be bounded summaries:

- invocation id;
- tool type;
- status;
- reason code;
- artifact ids;
- output excerpt if within cap;
- timing metadata;
- redacted policy trace.

Artifacts:

- Network response body/content excerpt artifacts under `runs/<runId>/tools/<toolInvocationId>/...` when `runId` exists.
- Detached invocation artifacts under `tools/<toolInvocationId>/...` when no `runId` exists.
- Process transcript artifacts for `repo` and `shell` include stdout/stderr excerpts, truncation flags, exit code, duration, and command id. They do not include raw env or full command secrets.
- GitHub large responses may store bounded JSON artifacts.

Artifact writes must be best-effort visible: if tool execution succeeds but artifact write fails, the invocation should be `failed` with `tool_artifact_write_failed` unless the response can be represented entirely within the inline output cap.

### Placement Boundary

R17 real tool execution is local-daemon only:

- `apps/daemon` may execute configured real tools.
- `apps/server` must not register middleware tool routes for hosted clients.
- `apps/worker` must not execute real tools.
- `apps/node` must not advertise real tool execution by default.
- If connected-node policy config gains tool-related fields, they must be capability truth only and must deny execution until a future node-owned executor exists.

This boundary is intentional because hosted sandbox is fake/no-spend, the server currently does not expose middleware routes, and node assignment execution does not yet run real adapters.

## User-Visible Behavior

- Real tools disabled by default: a `POST /tools/invocations` request for `fetch`, `web_search`, `github`, `repo`, `shell`, or `browser` returns a stable error envelope with `tool_policy_denied`, persists a denied invocation, and never dispatches an adapter. Existing `fake_echo` behavior remains unchanged.
- Enabled `fetch` with allowed host: the request creates a pending approval by default. The user approves through existing approval endpoints. Switchyard performs the bounded fetch, emits `tool.call` and `tool.result`, and returns a completed invocation with redacted summary plus artifact metadata if content was captured.
- Rejected approval: the queued invocation becomes `denied`, emits one `tool.result`, and no network/process/GitHub call occurs.
- Expired approval: the queued invocation becomes `denied` with `approval_expired`, emits one `tool.result`, and no adapter side effect occurs.
- Disallowed host, private IP, localhost, metadata-service URL, unallowlisted repo, unallowlisted cwd, unknown shell command id, mutating GitHub operation, or browser tool request: Switchyard returns `tool_policy_denied` with a specific reason code and stores a denied invocation.
- External provider unavailable: `web_search` or `github` completes as `failed` with `tool_upstream_unavailable`, `github_token_missing`, `github_rate_limited`, or another named reason. Secrets do not appear in logs/events/artifacts.
- Oversized output: inline output is truncated or omitted, artifact content is capped, and `truncated: true` metadata is visible.
- Hosted or connected-node request path: hosted server has no tool invocation route in R17; connected-node capability truth says real tools are unshipped. Product docs must state this plainly.

## Data Flows And Shadow Paths

### Flow 1: Tool Invocation API To Policy Decision

- Happy path: body has known `type`, object `input`, optional existing `runId`, and input within limits. Policy returns deny, approval, or allow; invocation record is persisted for every terminal decision.
- Nil path: missing body, missing `type`, missing `input`, or unknown `runId` returns `invalid_input` or `run_not_found`; no adapter dispatch occurs.
- Empty path: empty input object, empty URL/query/owner/repo/command id/pathspec returns `invalid_input` or `tool_policy_denied` with a field-specific reason; no adapter dispatch occurs.
- Error path: policy config parse failure or policy engine exception returns `tool_policy_failed`, persists denied/failed invocation when safe, logs redacted reason, and does not dispatch an adapter.

### Flow 2: Approval-Gated Tool Execution

- Happy path: approval is pending, user approves once, policy revalidates, adapter runs once, invocation becomes `completed` or `failed`, and one `tool.result` is emitted.
- Nil path: missing approval id or queued invocation link returns `approval_not_found` or `tool_invocation_not_found`; no adapter dispatch occurs.
- Empty path: approve/reject body with empty actor/reason is accepted using default actor/reason text; empty answers are ignored after redaction.
- Error path: duplicate approval resolution returns `approval_not_pending`; adapter is not run twice. Approval expiration or rejection terminalizes the queued invocation as `denied`.

### Flow 3: Network Tools (`fetch`, `web_search`, `github`)

- Happy path: allowlisted target, bounded input, approval approved, upstream returns within timeout/size caps, output summary and artifacts are stored.
- Nil path: missing URL/query/GitHub token/owner/repo/ref returns named `invalid_input`, `tool_unavailable`, or `github_token_missing`; no upstream request for malformed user input.
- Empty path: empty query returns `invalid_input`; search provider returning zero results completes successfully with `results: []`; empty HTTP body completes with metadata and no content artifact unless requested.
- Error path: DNS failure, private-IP resolution, redirect outside allowlist, timeout, rate limit, 4xx/5xx, oversized body, unsupported content type, or provider decode error maps to a named failed invocation with redacted diagnostics.

### Flow 4: Local Process Tools (`repo`, `shell`)

- Happy path: cwd is under an allowed prefix, command/operation is allowlisted, argv is fixed/bounded, approval is approved, process exits within timeout, stdout/stderr are capped and persisted.
- Nil path: missing cwd, operation, command id, executable, or catalog entry returns `invalid_input` or `tool_policy_denied`; no process starts.
- Empty path: empty pathspec means the operation-specific safe default only when allowed by policy; otherwise it returns `invalid_input`. Empty stdout is a successful completed invocation with `stdoutBytes: 0`.
- Error path: spawn error, non-zero exit, timeout, output flood, cancellation, cwd traversal, disallowed binary, policy mismatch, or artifact write failure maps to named `tool_process_*` or `tool_artifact_write_failed` reasons.

### Flow 5: Artifact Persistence

- Happy path: output exceeds inline cap or capture is requested; adapter writes bounded artifact content with digest/size/truncation metadata and links artifact id in `tool.result`.
- Nil path: no artifact store configured for a daemon path that needs content returns `tool_artifact_store_unavailable` and fails the invocation unless inline output suffices.
- Empty path: zero-byte response or process output stores no raw content artifact unless metadata-only artifact is explicitly useful; invocation can still complete.
- Error path: artifact write failure, digest mismatch, content too large, or redaction failure marks invocation failed with a named reason and emits redacted diagnostics.

## Constraints

- Deny-by-default is mandatory and test-covered.
- Real tools are local-daemon only in R17.
- Every real tool requires explicit operator config before execution.
- Every real tool requires approval by default.
- Adapter execution must happen after policy and after approval resolution.
- Stored execution plans must be immutable enough that a user cannot approve one target and execute another.
- Output and artifact bounds are hard limits, not best-effort comments.
- Logs and metrics must avoid raw prompt text, response bodies, query strings with secret-looking keys, GitHub tokens, env vars, cwd beyond configured-safe summary when sensitive, and process stdout/stderr content unless explicitly redacted and bounded.
- Network tools must mitigate SSRF and private-network access.
- Process tools must use direct spawn and argv arrays, not shell interpolation.
- Required tests and smoke must not call live paid provider APIs.
- OpenAPI must not expose arbitrary execution routes.
- Docs must not claim browser, connected-node, hosted, generic process, PTY, Cursor, OpenClaw, Paperclip, or runtime-specific wrapper approval bridges shipped in R17.

## Named Error And Reason Codes

R17 implementation should use stable names in service errors, event payloads, invocation errors, policy traces, and tests:

- `tool_policy_denied`
- `tool_policy_config_invalid`
- `tool_policy_failed`
- `tool_real_tools_disabled`
- `tool_real_tools_local_only`
- `tool_approval_required`
- `tool_approval_expired`
- `tool_approval_rejected`
- `tool_adapter_unavailable`
- `tool_upstream_unavailable`
- `tool_upstream_timeout`
- `tool_upstream_rate_limited`
- `tool_upstream_decode_failed`
- `tool_output_limit_exceeded`
- `tool_artifact_write_failed`
- `tool_redaction_failed`
- `fetch_url_invalid`
- `fetch_host_not_allowlisted`
- `fetch_private_network_denied`
- `fetch_redirect_denied`
- `fetch_method_denied`
- `fetch_content_type_denied`
- `web_search_provider_unconfigured`
- `web_search_query_invalid`
- `github_token_missing`
- `github_repo_not_allowlisted`
- `github_operation_denied`
- `github_not_found`
- `github_rate_limited`
- `repo_cwd_denied`
- `repo_operation_denied`
- `repo_pathspec_invalid`
- `shell_command_denied`
- `shell_command_not_configured`
- `tool_process_spawn_failed`
- `tool_process_nonzero_exit`
- `tool_process_timeout`
- `tool_process_cancelled`
- `browser_tool_unshipped`

## Acceptance Criteria

- [ ] `fake_echo` behavior and existing approval flow remain backward compatible.
- [ ] Real tools are denied by default with no adapter dispatch and a persisted denied invocation.
- [ ] R17 supports configured local-daemon execution for `fetch`, `web_search`, `github`, `repo`, and command-catalog `shell`.
- [ ] `browser` is denied before adapter dispatch with `browser_tool_unshipped`.
- [ ] No real tool can run in hosted server, hosted worker, or connected-node default execution.
- [ ] Policy config validation fails closed in staging/production-like modes when real tools are enabled without allowlists, bounds, or approval config.
- [ ] Every real tool has explicit allowlist checks and named denial reasons.
- [ ] Every real tool requires approval by default, creates redacted approval payloads, and resolves exactly once.
- [ ] Approval reject and expiration terminalize queued real tool invocations as `denied` without adapter side effects.
- [ ] Policy is revalidated at approval resolution before adapter execution.
- [ ] Fetch denies private network/localhost/metadata-service targets before network side effects.
- [ ] Fetch redirects are bounded and revalidated.
- [ ] Web search is unavailable by default and no-spend tested with fake clients.
- [ ] GitHub supports only read-only allowlisted operations and never accepts tokens in request input.
- [ ] Repo operations are read-only, no-network, bounded, and use fixed argv arrays.
- [ ] Shell operations require configured command ids and never execute raw user command strings.
- [ ] Process execution captures stdout/stderr with byte caps, timeout, cancellation, and named errors.
- [ ] Inline output, artifacts, event payloads, invocation records, approval payloads, and logs are bounded and redacted.
- [ ] Artifact write failure has visible named behavior and does not silently drop debug evidence.
- [ ] REST tests cover happy, nil, empty, and upstream/error paths for each shipped tool type.
- [ ] REST response bodies and OpenAPI response schemas agree on tool invocation field names and envelopes.
- [ ] Deterministic fake tests cover network, GitHub, search, repo, shell, approval, duplicate-resolution, output flood, timeout, and artifact failure paths.
- [ ] OpenAPI route boundary tests prove no public arbitrary execution route or operation id was added.
- [ ] Product/development docs describe exactly what real tools shipped and exactly what remains unshipped.
- [ ] No required test, smoke, or doctor path spends money or requires live external API credentials.

## Required Tests And Smoke

Required tests must be deterministic and no-spend:

- Contract tests:
  - tool input schemas for every shipped type;
  - approval type additions if any;
  - OpenAPI schema generation for bounded tool invocation request/response;
  - forbidden route/operation id checks for `/sandbox`, `/exec`, `/pty`, `/terminal`, `/shell`, `/process`, `/command`, `/browser`, and `/search`.
- Core policy tests:
  - global disabled denies all real tools;
  - per-tool disabled denies;
  - allowlist happy paths;
  - nil/empty input paths;
  - policy exception path;
  - redacted policy trace;
  - approval required by default;
  - allow-without-approval only when explicitly configured for a safe fake/test policy.
- ToolRouter tests:
  - denied invocation persistence;
  - approval queued invocation;
  - approve executes once;
  - duplicate approve/reject no duplicate execution;
  - rejection and expiration deny;
  - adapter failure maps to failed invocation;
  - artifact write failure visible.
- Adapter tests:
  - fake fetch client happy, HEAD, redirect allowed, redirect denied, private IP denied, timeout, unsupported content type, output cap;
  - fake search client happy, zero results, provider unavailable, timeout, malformed response, oversized response;
  - fake GitHub client happy operations, repo denied, token missing, not found, rate limit, mutation denied, oversized response;
  - fake process factory repo/shell happy, cwd denied, path traversal, spawn failed, non-zero exit, timeout, cancellation, output flood.
- REST tests:
  - `POST /tools/invocations` invalid body, missing input, unknown type, each real type disabled, approval path, rejection path, completed path, failed path;
  - `GET /tools/invocations` and `GET /tools/invocations/:id` show redacted bounded records.
- Security tests:
  - representative secret keys `apiKey`, `authorization`, `token`, `password`, `cookie`, `privateKey`, `accessKey`, signed URL query params;
  - no private IP fetch after DNS/redirect;
  - no command injection through shell args/pathspecs.
- Docs/product truth checks:
  - R17 docs mention local-only real tools;
  - docs do not claim browser, hosted real tools, connected-node real tools, arbitrary process/PTY, Cursor, OpenClaw, Paperclip, dashboard, or TUI shipped.

Suggested command set for the implementation phase:

```bash
pnpm --filter @switchyard/contracts test
pnpm --filter @switchyard/core test -- tool
pnpm --filter @switchyard/protocol-rest test -- middleware
pnpm --filter @switchyard/daemon test
pnpm --filter @switchyard/adapters test -- compatibility
pnpm typecheck
pnpm test
pnpm build
pnpm lint
git diff --check
```

## Operational Concerns

Operators must be able to understand why a real tool did or did not run without seeing secrets or raw payloads.

Required logs:

- `tool.policy.denied`
- `tool.approval.queued`
- `tool.approval.expired`
- `tool.invoke.started`
- `tool.invoke.completed`
- `tool.invoke.failed`
- `tool.artifact.write_failed`
- `tool.redaction.failed`

Log fields must be low-cardinality and redacted:

- tool type;
- invocation id;
- run id when present;
- reason code;
- approval id when present;
- adapter id;
- duration bucket;
- output/artifact size bucket;
- host/repo/cwd summarized according to policy, not raw secrets.

Required metrics:

- invocations by tool type/status/reason;
- approvals queued/approved/rejected/expired by tool type;
- adapter failures by reason;
- output-limit hits;
- artifact write failures;
- policy denials;
- upstream timeout/rate-limit counts.

Startup behavior:

- Queued tool invocations whose approval is pending should remain queued if the approval is still valid.
- Expired approvals should be reconciled to `denied`.
- Running tool invocations from a prior daemon process must be reconciled to `failed` with `daemon_restarted` because local process/network execution cannot survive restart.

Config behavior:

- Missing or invalid real-tool config fails closed.
- Production-like config that enables real tools without allowlists, timeouts, output caps, and approval defaults fails at startup.
- A redacted config summary is logged once at startup when real tools are enabled.

## Documentation And Product Truth

The implementation phase must update product/development docs to say:

- R17 ships local-daemon real tools for `fetch`, `web_search`, `github`, `repo`, and command-catalog `shell` only when explicitly configured.
- `fake_echo` remains available for deterministic tests.
- `browser` is still unshipped.
- Connected-node real tool execution is still unshipped.
- Hosted real tool execution is still unshipped.
- Hosted arbitrary subprocess/PTY execution is still unshipped.
- Public `/sandbox`, `/exec`, `/pty`, `/terminal`, `/process`, `/shell`, `/command`, `/browser`, and `/search` routes remain unshipped.
- Cursor, OpenClaw, Paperclip, generic process runtime, generic PTY runtime, and runtime-specific approval bridges for OpenCode/AgentField/Generic HTTP remain unshipped.
- Dashboard and TUI are out of scope.
- Required tests and default smoke are no-spend.

Docs that must be reviewed during implementation:

- `PRODUCT.md`
- `README.md`
- `ARCHITECTURE.md`
- `docs/adapters/README.md`
- relevant `docs/development/...` pages if tool operator setup is documented

## Future Trajectory

R17 should leave clean future seams without claiming those futures are done:

- R18 candidate: connected-node real tool execution, using node-owned policy, tool adapter construction, assignment-scoped approvals, artifact sync bounds, and server-side capability truth.
- R19 candidate: real browser tool with headless browser isolation, network policy, screenshot/artifact policy, page script restrictions, and deterministic fake browser tests.
- Future hosted candidate: production sandboxed process/PTY worker class only after kernel/container isolation, network egress policy, identity, audit, and operator runbooks exist.
- Future adapter candidate: Cursor after local auth/stream shape verification.
- Future wrapper candidates: OpenClaw and Paperclip after stable API boundaries are verified.
- Future runtime approval bridge candidates: OpenCode ACP permission resolution, AgentField approval endpoints, and Generic HTTP approval endpoints after runtime-specific request/resolution shapes are verified and no-spend tests prove them.

## Phase

### Phase 16: R17 Production Tools And Adapter Expansion

**Goal:** Ship the smallest production-grade local real-tool slice with explicit deny-by-default policy, approvals, bounds, redaction, fake/no-spend tests, docs truth, and OpenAPI route boundary checks.

**Acceptance:**

- Local daemon can execute configured `fetch`, `web_search`, `github`, `repo`, and command-catalog `shell` tools through `/tools/invocations`.
- Real tools are disabled by default, require allowlists, and require approval by default.
- Browser, connected-node real tools, hosted real tools, arbitrary process/PTY, broad adapters, dashboard, and TUI remain unshipped and documented.
- Inputs, outputs, artifacts, logs, events, and approval payloads are bounded and redacted.
- Fake/no-spend tests cover happy, nil, empty, and error paths for every data flow.
- OpenAPI tests prove no public arbitrary execution routes were added.

**Non-goals (this phase):** Dashboard; TUI; enterprise auth/billing; managed hosted production platform; hosted arbitrary subprocess/PTY; hosted real tools; connected-node real tools; browser automation; generic process runtime; generic PTY runtime; Cursor; OpenClaw; Paperclip; runtime-specific approval bridges for OpenCode/AgentField/Generic HTTP.

**Complexity:** L
