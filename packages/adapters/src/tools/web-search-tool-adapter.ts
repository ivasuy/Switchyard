import { AdapterProtocolError, type RuntimeLogger, type ToolAdapter, type WebSearchToolExecutionPlan } from "@switchyard/core";
import { redactSecrets } from "@switchyard/core";

export interface SearchClient {
  search(input: {
    providerId: string;
    baseUrl: string;
    query: string;
    maxResults: number;
    timeoutMs: number;
    maxResponseBytes: number;
  }): Promise<Array<{ title: string; url: string; snippet: string }>>;
}

export interface WebSearchToolAdapterOptions {
  client?: SearchClient;
  fetchImpl?: typeof fetch;
  logger?: RuntimeLogger;
  clock?: () => Date;
}

export class WebSearchToolAdapter implements ToolAdapter {
  readonly id = "web_search";
  private readonly client: SearchClient;

  constructor(private readonly options: WebSearchToolAdapterOptions = {}) {
    this.client = options.client ?? new HttpSearchClient(options.fetchImpl ?? fetch);
  }

  async check(): Promise<{ ok: boolean; message?: string }> {
    return { ok: true };
  }

  async invoke(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const plan = readPlan(input);
    const startedAt = this.now().getTime();

    try {
      const results = await this.client.search({
        providerId: plan.providerId,
        baseUrl: plan.baseUrl,
        query: plan.query,
        maxResults: plan.maxResults,
        timeoutMs: plan.timeoutMs,
        maxResponseBytes: plan.maxResponseBytes
      });
      const mapped = results.slice(0, plan.maxResults).map((result, index) => ({
        provider: plan.providerId,
        rank: index + 1,
        title: redactSecrets(result.title),
        url: redactSecrets(result.url),
        snippet: redactSecrets(result.snippet)
      }));
      const payloadBytes = Buffer.byteLength(JSON.stringify(mapped), "utf8");
      if (payloadBytes > plan.maxResponseBytes) {
        throw new AdapterProtocolError("Search payload exceeds configured limit", {
          reasonCode: "tool_output_limit_exceeded"
        });
      }
      return {
        summary: {
          provider: plan.providerId,
          query: redactSecrets(plan.query),
          resultsCount: mapped.length,
          durationMs: this.now().getTime() - startedAt
        },
        inlineOutput: {
          results: mapped
        },
        truncated: payloadBytes > plan.maxInlineOutputBytes
      };
    } catch (error) {
      if (error instanceof AdapterProtocolError) {
        throw error;
      }
      throw new AdapterProtocolError(error instanceof Error ? error.message : String(error), {
        reasonCode: "tool_upstream_unavailable"
      });
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

class HttpSearchClient implements SearchClient {
  constructor(private readonly fetchImpl: typeof fetch) {}

  async search(input: {
    providerId: string;
    baseUrl: string;
    query: string;
    maxResults: number;
    timeoutMs: number;
    maxResponseBytes: number;
  }): Promise<Array<{ title: string; url: string; snippet: string }>> {
    const url = new URL(input.baseUrl);
    url.searchParams.set("q", input.query);
    url.searchParams.set("limit", String(input.maxResults));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const response = await this.fetchImpl(url.toString(), {
        method: "GET",
        signal: controller.signal
      });
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > input.maxResponseBytes) {
        throw new AdapterProtocolError("Search response too large", { reasonCode: "tool_output_limit_exceeded" });
      }
      if (!response.ok) {
        throw new AdapterProtocolError(`Search provider returned ${response.status}`, {
          reasonCode: response.status === 429 ? "web_search_rate_limited" : "tool_upstream_unavailable"
        });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new AdapterProtocolError("Malformed search response", {
          reasonCode: "tool_upstream_decode_failed"
        });
      }
      const array = extractSearchArray(parsed);
      return array.map((item) => ({
        title: String(item["title"] ?? ""),
        url: String(item["url"] ?? ""),
        snippet: String(item["snippet"] ?? "")
      }));
    } catch (error) {
      if (error instanceof AdapterProtocolError) {
        throw error;
      }
      if (error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message))) {
        throw new AdapterProtocolError("Search provider timed out", { reasonCode: "tool_upstream_timeout" });
      }
      throw new AdapterProtocolError(error instanceof Error ? error.message : String(error), {
        reasonCode: "tool_upstream_unavailable"
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

function readPlan(input: Record<string, unknown>): WebSearchToolExecutionPlan {
  const plan = input["executionPlan"];
  if (!plan || typeof plan !== "object") {
    throw new AdapterProtocolError("Missing execution plan", { reasonCode: "tool_policy_failed" });
  }
  const candidate = plan as WebSearchToolExecutionPlan;
  if (candidate.type !== "web_search") {
    throw new AdapterProtocolError("Execution plan type mismatch", { reasonCode: "tool_policy_failed" });
  }
  return candidate;
}

function extractSearchArray(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object") {
    throw new AdapterProtocolError("Malformed search response", {
      reasonCode: "tool_upstream_decode_failed"
    });
  }
  const record = value as Record<string, unknown>;
  const raw = record["results"];
  if (!Array.isArray(raw)) {
    throw new AdapterProtocolError("Malformed search response", {
      reasonCode: "tool_upstream_decode_failed"
    });
  }
  return raw.filter((entry) => entry && typeof entry === "object") as Array<Record<string, unknown>>;
}
