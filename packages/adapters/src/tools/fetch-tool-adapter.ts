import { lookup as dnsLookup } from "node:dns/promises";
import { AdapterProtocolError, type RuntimeLogger, type ToolAdapter } from "@switchyard/core";
import type { FetchToolExecutionPlan } from "@switchyard/core";
import { redactSecrets } from "@switchyard/core";

export interface FetchToolAdapterOptions {
  fetchImpl?: typeof fetch;
  lookup?: typeof dnsLookup;
  logger?: RuntimeLogger;
  clock?: () => Date;
}

export class FetchToolAdapter implements ToolAdapter {
  readonly id = "fetch";
  private readonly fetchImpl: typeof fetch;
  private readonly lookup: typeof dnsLookup;

  constructor(private readonly options: FetchToolAdapterOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.lookup = options.lookup ?? dnsLookup;
  }

  async check(): Promise<{ ok: boolean; message?: string }> {
    return { ok: true };
  }

  async invoke(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const plan = readPlan(input);
    const startedAt = this.now().getTime();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), plan.timeoutMs);

    try {
      let currentUrl = plan.url;
      let redirectCount = 0;
      while (true) {
        await this.validateResolvedTarget(currentUrl, plan.allowedHosts);
        const response = await this.fetchImpl(currentUrl, {
          method: plan.method,
          redirect: "manual",
          signal: controller.signal
        });

        if (isRedirect(response.status)) {
          const location = response.headers.get("location");
          if (!location) {
            throw new AdapterProtocolError("Redirect response missing location", {
              reasonCode: "fetch_redirect_denied"
            });
          }
          if (redirectCount >= plan.maxRedirects) {
            throw new AdapterProtocolError("Redirect limit exceeded", {
              reasonCode: "fetch_redirect_denied"
            });
          }
          currentUrl = new URL(location, currentUrl).toString();
          redirectCount += 1;
          continue;
        }

        if (!response.ok) {
          throw new AdapterProtocolError(`Upstream returned HTTP ${response.status}`, {
            reasonCode: "tool_upstream_unavailable",
            details: {
              status: response.status,
              statusBucket: response.status >= 500 ? "5xx" : "4xx"
            }
          });
        }

        const contentType = response.headers.get("content-type") ?? "application/octet-stream";
        if (plan.allowedContentTypes.length > 0 && !matchesAllowedContentType(contentType, plan.allowedContentTypes)) {
          throw new AdapterProtocolError("Response content type is not allowlisted", {
            reasonCode: "fetch_content_type_denied"
          });
        }

        const body = plan.method === "HEAD" ? "" : await readBodyWithCap(response, plan.maxResponseBytes);
        const redactedBody = redactSecrets(body);
        const output: Record<string, unknown> = {
          summary: {
            status: response.status,
            statusBucket: response.status >= 500 ? "5xx" : response.status >= 400 ? "4xx" : "2xx",
            method: plan.method,
            url: currentUrl,
            redirectCount,
            contentType,
            bytes: Buffer.byteLength(body, "utf8")
          },
          inlineOutput: {
            excerpt: redactedBody.slice(0, plan.maxInlineOutputBytes)
          },
          truncated: Buffer.byteLength(redactedBody, "utf8") > plan.maxInlineOutputBytes
        };

        if (plan.captureContent && redactedBody.length > 0) {
          output["artifactCandidates"] = [
            {
              logicalPath: "response-body.txt",
              type: "raw_log",
              content: redactedBody.slice(0, plan.maxArtifactBytes),
              contentType,
              metadata: {
                truncated: Buffer.byteLength(redactedBody, "utf8") > plan.maxArtifactBytes,
                status: response.status,
                redirectCount
              }
            }
          ];
        }

        this.options.logger?.info("tool.adapter.fetch.completed", {
          status: response.status,
          redirectCount,
          durationMs: this.now().getTime() - startedAt
        });

        return output;
      }
    } catch (error) {
      if (isAbortError(error)) {
        throw new AdapterProtocolError("Fetch timed out", { reasonCode: "tool_upstream_timeout" });
      }
      if (error instanceof AdapterProtocolError) {
        throw error;
      }
      throw new AdapterProtocolError(error instanceof Error ? error.message : String(error), {
        reasonCode: "tool_upstream_unavailable"
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async cancel(): Promise<void> {
    return;
  }

  async artifacts(): Promise<[]> {
    return [];
  }

  private async validateResolvedTarget(url: string, allowedHosts: string[]): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new AdapterProtocolError("Invalid URL", { reasonCode: "fetch_url_invalid" });
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new AdapterProtocolError("Only HTTP/S is allowed", { reasonCode: "fetch_url_invalid" });
    }
    const host = parsed.hostname.toLowerCase();
    const hostAllowed = allowedHosts.map((value) => value.toLowerCase()).includes(host);
    if (!hostAllowed) {
      throw new AdapterProtocolError("Host is not allowlisted", { reasonCode: "fetch_host_not_allowlisted" });
    }

    const lookupResult = await this.lookup(host, { all: true });
    const records = Array.isArray(lookupResult) ? lookupResult : [lookupResult];
    for (const record of records) {
      const address = record.address;
      if (isPrivateAddress(address)) {
        throw new AdapterProtocolError("Private network address denied", {
          reasonCode: "fetch_private_network_denied"
        });
      }
    }
  }

  private now(): Date {
    return this.options.clock ? this.options.clock() : new Date();
  }
}

function readPlan(input: Record<string, unknown>): FetchToolExecutionPlan {
  const plan = input["executionPlan"];
  if (!plan || typeof plan !== "object") {
    throw new AdapterProtocolError("Missing execution plan", { reasonCode: "tool_policy_failed" });
  }
  const candidate = plan as FetchToolExecutionPlan;
  if (candidate.type !== "fetch") {
    throw new AdapterProtocolError("Execution plan type mismatch", { reasonCode: "tool_policy_failed" });
  }
  return candidate;
}

function isPrivateAddress(address: string): boolean {
  if (address === "::1" || address.startsWith("fe80:") || address.startsWith("fc") || address.startsWith("fd")) {
    return true;
  }
  if (address.startsWith("127.")) {
    return true;
  }
  if (address.startsWith("10.")) {
    return true;
  }
  if (address.startsWith("192.168.")) {
    return true;
  }
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) {
    return true;
  }
  if (address.startsWith("169.254.")) {
    return true;
  }
  if (address === "0.0.0.0" || address === "169.254.169.254") {
    return true;
  }
  return false;
}

async function readBodyWithCap(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) {
    return "";
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    bytes += next.value.byteLength;
    if (bytes > maxBytes) {
      throw new AdapterProtocolError("Response exceeds configured limit", {
        reasonCode: "tool_output_limit_exceeded"
      });
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function matchesAllowedContentType(contentType: string, allowlist: string[]): boolean {
  const normalized = contentType.toLowerCase();
  return allowlist.some((entry) => normalized.startsWith(entry.toLowerCase()));
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message));
}
