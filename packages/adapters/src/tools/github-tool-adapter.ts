import {
  AdapterProtocolError,
  type GithubToolExecutionPlan,
  type RuntimeLogger,
  type ToolAdapter
} from "@switchyard/core";
import { redactSecrets } from "@switchyard/core";

export interface GithubClient {
  call(operation: GithubToolExecutionPlan["operation"], plan: GithubToolExecutionPlan): Promise<unknown>;
}

export interface GithubToolAdapterOptions {
  token?: string;
  client?: GithubClient;
  fetchImpl?: typeof fetch;
  logger?: RuntimeLogger;
  clock?: () => Date;
}

export class GithubToolAdapter implements ToolAdapter {
  readonly id = "github";
  private readonly client: GithubClient;

  constructor(private readonly options: GithubToolAdapterOptions = {}) {
    this.client = options.client ?? new HttpGithubClient(options.fetchImpl ?? fetch, options.token);
  }

  async check(): Promise<{ ok: boolean; message?: string }> {
    if (!this.options.token && !this.options.client) {
      return { ok: false, message: "GitHub token is missing" };
    }
    return { ok: true };
  }

  async invoke(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const plan = readPlan(input);
    if (!this.options.token && !this.options.client) {
      throw new AdapterProtocolError("GitHub token is missing", { reasonCode: "github_token_missing" });
    }

    const startedAt = this.now().getTime();
    try {
      const payload = await this.client.call(plan.operation, plan);
      const json = JSON.stringify(payload);
      if (Buffer.byteLength(json, "utf8") > plan.maxResponseBytes) {
        throw new AdapterProtocolError("GitHub payload exceeds configured limit", {
          reasonCode: "tool_output_limit_exceeded"
        });
      }
      return {
        summary: {
          operation: plan.operation,
          owner: plan.owner,
          repo: plan.repo,
          durationMs: this.now().getTime() - startedAt
        },
        inlineOutput: redactSecrets(payload as Record<string, unknown>),
        truncated: Buffer.byteLength(json, "utf8") > plan.maxInlineOutputBytes
      };
    } catch (error) {
      if (error instanceof AdapterProtocolError) {
        throw error;
      }
      throw mapGithubError(error, plan);
    }
  }

  async cancel(): Promise<void> {
    return;
  }

  async artifacts(): Promise<[]> {
    return [];
  }

  private now(): Date {
    return this.options.clock ? this.options.clock() : new Date();
  }
}

class HttpGithubClient implements GithubClient {
  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly token: string | undefined
  ) {}

  async call(operation: GithubToolExecutionPlan["operation"], plan: GithubToolExecutionPlan): Promise<unknown> {
    if (!this.token) {
      throw new AdapterProtocolError("GitHub token is missing", { reasonCode: "github_token_missing" });
    }

    const endpoint = buildGithubEndpoint(operation, plan);
    const response = await this.fetchImpl(endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "switchyard-r17"
      }
    });

    const text = await response.text();
    const rateRemaining = response.headers.get("x-ratelimit-remaining");
    if (response.status === 429 || rateRemaining === "0") {
      throw new AdapterProtocolError("GitHub rate limit exceeded", {
        reasonCode: "github_rate_limited",
        details: { status: response.status }
      });
    }
    if (response.status === 404) {
      throw new AdapterProtocolError("GitHub resource not found", {
        reasonCode: "github_not_found",
        details: { status: response.status }
      });
    }
    if (response.status === 403) {
      throw new AdapterProtocolError("GitHub upstream unavailable", {
        reasonCode: "tool_upstream_unavailable",
        details: { status: response.status, rateRemaining }
      });
    }
    if (!response.ok) {
      throw new AdapterProtocolError("GitHub upstream unavailable", {
        reasonCode: "tool_upstream_unavailable",
        details: { status: response.status }
      });
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new AdapterProtocolError("GitHub payload decode failed", {
        reasonCode: "tool_upstream_decode_failed"
      });
    }
  }
}

function readPlan(input: Record<string, unknown>): GithubToolExecutionPlan {
  const plan = input["executionPlan"];
  if (!plan || typeof plan !== "object") {
    throw new AdapterProtocolError("Missing execution plan", { reasonCode: "tool_policy_failed" });
  }
  const candidate = plan as GithubToolExecutionPlan;
  if (candidate.type !== "github") {
    throw new AdapterProtocolError("Execution plan type mismatch", { reasonCode: "tool_policy_failed" });
  }
  return candidate;
}

function buildGithubEndpoint(operation: GithubToolExecutionPlan["operation"], plan: GithubToolExecutionPlan): string {
  const base = `https://api.github.com/repos/${encodeURIComponent(plan.owner)}/${encodeURIComponent(plan.repo)}`;
  switch (operation) {
    case "get_issue":
      return `${base}/issues/${plan.number}`;
    case "get_pull":
      return `${base}/pulls/${plan.number}`;
    case "list_pull_files":
      return `${base}/pulls/${plan.number}/files`;
    case "get_file": {
      const url = new URL(`${base}/contents/${plan.path}`);
      if (plan.ref) {
        url.searchParams.set("ref", plan.ref);
      }
      return url.toString();
    }
    case "compare_refs":
      return `${base}/compare/${encodeURIComponent(plan.base ?? "")}%E2%80%A6${encodeURIComponent(plan.head ?? "")}`;
  }
}

function mapGithubError(error: unknown, plan: GithubToolExecutionPlan): AdapterProtocolError {
  if (error instanceof AdapterProtocolError) {
    return error;
  }
  if (error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message))) {
    return new AdapterProtocolError("GitHub request timed out", {
      reasonCode: "tool_upstream_timeout",
      details: {
        operation: plan.operation,
        owner: plan.owner,
        repo: plan.repo
      }
    });
  }
  return new AdapterProtocolError(error instanceof Error ? error.message : String(error), {
    reasonCode: "tool_upstream_unavailable",
    details: {
      operation: plan.operation,
      owner: plan.owner,
      repo: plan.repo
    }
  });
}
