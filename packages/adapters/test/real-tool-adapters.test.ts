import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { AdapterProtocolError } from "@switchyard/core";
import { describe, expect, it } from "vitest";
import {
  FetchToolAdapter,
  GithubToolAdapter,
  LocalProcessToolExecutor,
  RepoToolAdapter,
  ShellCatalogToolAdapter,
  WebSearchToolAdapter,
  type LocalProcessFactory,
  type SearchClient,
  type GithubClient
} from "../src/index.js";

describe("real tool adapters", () => {
  it("fetch handles GET happy path", async () => {
    const adapter = new FetchToolAdapter({
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async () => new Response("ok-response", {
        status: 200,
        headers: { "content-type": "text/plain" }
      })
    });

    const output = await adapter.invoke({
      executionPlan: {
        type: "fetch",
        method: "GET",
        url: "https://example.com/path",
        allowedHosts: ["example.com"],
        allowedHeaders: [],
        maxRedirects: 2,
        allowedContentTypes: ["text/plain"],
        captureContent: true,
        timeoutMs: 2000,
        maxResponseBytes: 1024,
        maxInlineOutputBytes: 256,
        maxArtifactBytes: 512
      }
    });

    expect((output.summary as Record<string, unknown>).status).toBe(200);
    expect(Array.isArray(output.artifactCandidates)).toBe(true);
  });

  it("fetch handles HEAD without body artifacts", async () => {
    const adapter = new FetchToolAdapter({
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async () => new Response("", {
        status: 200,
        headers: { "content-type": "text/plain" }
      })
    });

    const output = await adapter.invoke({
      executionPlan: {
        type: "fetch",
        method: "HEAD",
        url: "https://example.com/path",
        allowedHosts: ["example.com"],
        allowedHeaders: [],
        maxRedirects: 2,
        allowedContentTypes: ["text/plain"],
        captureContent: true,
        timeoutMs: 2000,
        maxResponseBytes: 1024,
        maxInlineOutputBytes: 256,
        maxArtifactBytes: 512
      }
    });

    expect((output.summary as Record<string, unknown>).method).toBe("HEAD");
    expect(output.artifactCandidates).toBeUndefined();
  });

  it("fetch follows allowlisted redirects", async () => {
    const calls: string[] = [];
    const adapter = new FetchToolAdapter({
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async (url) => {
        calls.push(String(url));
        if (calls.length === 1) {
          return new Response("", {
            status: 302,
            headers: { location: "https://example.com/next" }
          });
        }
        return new Response("final-body", {
          status: 200,
          headers: { "content-type": "text/plain" }
        });
      }
    });

    const output = await adapter.invoke({
      executionPlan: {
        type: "fetch",
        method: "GET",
        url: "https://example.com/start",
        allowedHosts: ["example.com"],
        allowedHeaders: [],
        maxRedirects: 2,
        allowedContentTypes: ["text/plain"],
        captureContent: false,
        timeoutMs: 2000,
        maxResponseBytes: 1024,
        maxInlineOutputBytes: 256,
        maxArtifactBytes: 512
      }
    });

    expect(calls).toEqual(["https://example.com/start", "https://example.com/next"]);
    expect((output.summary as Record<string, unknown>).redirectCount).toBe(1);
  });

  it("fetch denies redirects that leave the allowlist", async () => {
    const calls: string[] = [];
    const adapter = new FetchToolAdapter({
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async (url) => {
        calls.push(String(url));
        return new Response("", {
          status: 302,
          headers: { location: "https://evil.example/next" }
        });
      }
    });

    await expect(adapter.invoke({
      executionPlan: {
        type: "fetch",
        method: "GET",
        url: "https://example.com/start",
        allowedHosts: ["example.com"],
        allowedHeaders: [],
        maxRedirects: 2,
        allowedContentTypes: ["text/plain"],
        captureContent: false,
        timeoutMs: 2000,
        maxResponseBytes: 1024,
        maxInlineOutputBytes: 256,
        maxArtifactBytes: 512
      }
    })).rejects.toMatchObject({ reasonCode: "fetch_host_not_allowlisted" });

    expect(calls).toHaveLength(1);
  });

  it("fetch revalidates redirects and denies private resolved targets", async () => {
    const calls: string[] = [];
    const adapter = new FetchToolAdapter({
      lookup: async (host) => {
        if (host === "example.com") {
          return [{ address: "93.184.216.34", family: 4 }];
        }
        return [{ address: "10.0.0.4", family: 4 }];
      },
      fetchImpl: async (url) => {
        calls.push(String(url));
        if (calls.length === 1) {
          return new Response("", {
            status: 302,
            headers: { location: "https://mirror.example/path" }
          });
        }
        return new Response("should-not-happen", { status: 200 });
      }
    });

    await expect(adapter.invoke({
      executionPlan: {
        type: "fetch",
        method: "GET",
        url: "https://example.com/start",
        allowedHosts: ["example.com", "mirror.example"],
        allowedHeaders: [],
        maxRedirects: 2,
        allowedContentTypes: ["text/plain"],
        captureContent: false,
        timeoutMs: 2000,
        maxResponseBytes: 1024,
        maxInlineOutputBytes: 256,
        maxArtifactBytes: 512
      }
    })).rejects.toMatchObject({ reasonCode: "fetch_private_network_denied" });

    expect(calls).toHaveLength(1);
  });

  it("fetch maps 404 and 500 to tool_upstream_unavailable", async () => {
    const notFoundAdapter = new FetchToolAdapter({
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async () => new Response("token=secret", { status: 404 })
    });
    await expect(notFoundAdapter.invoke({ executionPlan: baseFetchPlan() })).rejects.toMatchObject({
      reasonCode: "tool_upstream_unavailable",
      details: { status: 404, statusBucket: "4xx" }
    });

    const serverErrorAdapter = new FetchToolAdapter({
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async () => new Response("Authorization: bearer secret", { status: 500 })
    });
    await expect(serverErrorAdapter.invoke({ executionPlan: baseFetchPlan() })).rejects.toMatchObject({
      reasonCode: "tool_upstream_unavailable",
      details: { status: 500, statusBucket: "5xx" }
    });
  });

  it("fetch denies disallowed content type", async () => {
    const adapter = new FetchToolAdapter({
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async () => new Response("<html>doc</html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      })
    });
    await expect(adapter.invoke({
      executionPlan: {
        ...baseFetchPlan(),
        allowedContentTypes: ["application/json"]
      }
    })).rejects.toMatchObject({ reasonCode: "fetch_content_type_denied" });
  });

  it("fetch enforces response byte cap", async () => {
    const adapter = new FetchToolAdapter({
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async () => new Response("x".repeat(2048), {
        status: 200,
        headers: { "content-type": "text/plain" }
      })
    });
    await expect(adapter.invoke({
      executionPlan: {
        ...baseFetchPlan(),
        maxResponseBytes: 32
      }
    })).rejects.toMatchObject({ reasonCode: "tool_output_limit_exceeded" });
  });

  it("web search returns bounded ranked results", async () => {
    const client: SearchClient = {
      async search() {
        return [
          { title: "One", url: "https://example.com/1", snippet: "A" },
          { title: "Two", url: "https://example.com/2", snippet: "B" }
        ];
      }
    };
    const adapter = new WebSearchToolAdapter({ client });
    const output = await adapter.invoke({
      executionPlan: {
        type: "web_search",
        providerId: "fake-search",
        baseUrl: "https://search.example/api",
        query: "switchyard",
        maxResults: 5,
        timeoutMs: 1000,
        maxResponseBytes: 4096,
        maxInlineOutputBytes: 4096,
        maxArtifactBytes: 4096
      }
    });

    const results = (output.inlineOutput as Record<string, unknown>).results as Array<Record<string, unknown>>;
    expect(results[0]?.rank).toBe(1);
    expect(results[1]?.provider).toBe("fake-search");
  });

  it("web search truncates inline output to maxInlineOutputBytes", async () => {
    const client: SearchClient = {
      async search() {
        return Array.from({ length: 5 }, (_, index) => ({
          title: `Result ${index}`,
          url: `https://example.com/${index}`,
          snippet: "s".repeat(256)
        }));
      }
    };
    const adapter = new WebSearchToolAdapter({ client });
    const output = await adapter.invoke({
      executionPlan: {
        type: "web_search",
        providerId: "fake-search",
        baseUrl: "https://search.example/api",
        query: "switchyard",
        maxResults: 5,
        timeoutMs: 1000,
        maxResponseBytes: 32_768,
        maxInlineOutputBytes: 256,
        maxArtifactBytes: 4096
      }
    });

    const bytes = Buffer.byteLength(JSON.stringify(output.inlineOutput), "utf8");
    expect(output.truncated).toBe(true);
    expect(bytes).toBeLessThanOrEqual(256);
  });

  it("web search maps provider failure, malformed payload, and oversize payload", async () => {
    const providerFailure = new WebSearchToolAdapter({
      fetchImpl: async () => new Response("upstream failure", { status: 500 })
    });
    await expect(providerFailure.invoke({
      executionPlan: {
        ...baseWebSearchPlan(),
        baseUrl: "https://search.example/api"
      }
    })).rejects.toMatchObject({ reasonCode: "tool_upstream_unavailable" });

    const malformed = new WebSearchToolAdapter({
      fetchImpl: async () => new Response("not-json", { status: 200 })
    });
    await expect(malformed.invoke({
      executionPlan: {
        ...baseWebSearchPlan(),
        baseUrl: "https://search.example/api"
      }
    })).rejects.toMatchObject({ reasonCode: "tool_upstream_decode_failed" });

    const oversize = new WebSearchToolAdapter({
      fetchImpl: async () => new Response(JSON.stringify({
        results: [{ title: "x", url: "https://example.com", snippet: "y".repeat(2048) }]
      }), { status: 200 })
    });
    await expect(oversize.invoke({
      executionPlan: {
        ...baseWebSearchPlan(),
        baseUrl: "https://search.example/api",
        maxResponseBytes: 128
      }
    })).rejects.toMatchObject({ reasonCode: "tool_output_limit_exceeded" });
  });

  it("github returns summary on happy path", async () => {
    const client: GithubClient = {
      async call() {
        return { title: "Issue", body: "safe" };
      }
    };
    const adapter = new GithubToolAdapter({ token: "ghp_secret", client });
    const output = await adapter.invoke({
      executionPlan: baseGithubPlan(1)
    });

    expect((output.summary as Record<string, unknown>).operation).toBe("get_issue");
  });

  it("github maps not_found and 403 non-rate-limit", async () => {
    const missingClient: GithubClient = {
      async call() {
        throw new AdapterProtocolError("missing", { reasonCode: "github_not_found" });
      }
    };
    const missingAdapter = new GithubToolAdapter({ token: "ghp_secret", client: missingClient });
    await expect(missingAdapter.invoke({ executionPlan: baseGithubPlan(1) })).rejects.toMatchObject({
      reasonCode: "github_not_found"
    });

    const forbiddenClient: GithubClient = {
      async call() {
        throw new AdapterProtocolError("forbidden", { reasonCode: "tool_upstream_unavailable" });
      }
    };
    const forbiddenAdapter = new GithubToolAdapter({ token: "ghp_secret", client: forbiddenClient });
    await expect(forbiddenAdapter.invoke({ executionPlan: baseGithubPlan(1) })).rejects.toMatchObject({
      reasonCode: "tool_upstream_unavailable"
    });
  });

  it("github maps timeout errors", async () => {
    const timeoutClient: GithubClient = {
      async call() {
        const error = new Error("request aborted");
        error.name = "AbortError";
        throw error;
      }
    };
    const adapter = new GithubToolAdapter({ token: "ghp_secret", client: timeoutClient });
    await expect(adapter.invoke({ executionPlan: baseGithubPlan(1) })).rejects.toMatchObject({
      reasonCode: "tool_upstream_timeout"
    });
  });

  it("github enforces maxResponseBytes", async () => {
    const client: GithubClient = {
      async call() {
        return { blob: "x".repeat(4096) };
      }
    };
    const adapter = new GithubToolAdapter({ token: "ghp_secret", client });
    await expect(adapter.invoke({
      executionPlan: {
        ...baseGithubPlan(1),
        maxResponseBytes: 128
      }
    })).rejects.toMatchObject({ reasonCode: "tool_output_limit_exceeded" });
  });

  it("github maps 429 to github_rate_limited", async () => {
    const client: GithubClient = {
      async call() {
        throw new AdapterProtocolError("rate limit", { reasonCode: "github_rate_limited" });
      }
    };
    const adapter = new GithubToolAdapter({ token: "ghp_secret", client });

    await expect(adapter.invoke({
      executionPlan: {
        type: "github",
        operation: "get_issue",
        owner: "openai",
        repo: "codex",
        number: 1,
        timeoutMs: 1000,
        maxResponseBytes: 2048,
        maxInlineOutputBytes: 2048,
        maxArtifactBytes: 2048
      }
    })).rejects.toMatchObject({ reasonCode: "github_rate_limited" });
  });

  it("github truncates inline output to maxInlineOutputBytes", async () => {
    const client: GithubClient = {
      async call() {
        return {
          title: "Large payload",
          body: "x".repeat(4096),
          nested: {
            values: Array.from({ length: 32 }, (_, index) => ({ id: index, text: "y".repeat(128) }))
          }
        };
      }
    };
    const adapter = new GithubToolAdapter({ token: "ghp_secret", client });
    const output = await adapter.invoke({
      executionPlan: {
        type: "github",
        operation: "get_issue",
        owner: "openai",
        repo: "codex",
        number: 1,
        timeoutMs: 1000,
        maxResponseBytes: 16_384,
        maxInlineOutputBytes: 512,
        maxArtifactBytes: 2048
      }
    });

    const bytes = Buffer.byteLength(JSON.stringify(output.inlineOutput), "utf8");
    expect(output.truncated).toBe(true);
    expect(bytes).toBeLessThanOrEqual(512);
  });

  it("repo and shell execute via local process executor without shell interpolation", async () => {
    const invocations: Array<{ executablePath: string; argv: string[]; cwd: string; shell: false }> = [];
    const processFactory = createProcessFactory((input) => {
      invocations.push(input);
      return { stdout: "ok\n", stderr: "", code: 0 };
    });
    const executor = new LocalProcessToolExecutor({ processFactory });

    const repoAdapter = new RepoToolAdapter({ processExecutor: executor });
    const shellAdapter = new ShellCatalogToolAdapter({ processExecutor: executor });

    await repoAdapter.invoke({
      executionPlan: {
        type: "repo",
        operation: "diff",
        cwd: "/repo",
        cwdPolicySummary: "/repo",
        gitBinary: "/usr/bin/git",
        argv: ["diff", "--", "README.md"],
        pathspec: ["README.md"],
        timeoutMs: 1000,
        maxOutputBytes: 4096,
        maxInlineOutputBytes: 1024,
        maxArtifactBytes: 2048
      }
    });

    await shellAdapter.invoke({
      executionPlan: {
        type: "shell",
        commandId: "local.date.utc",
        executablePath: "/bin/date",
        argv: ["-u", "+%Y"],
        cwd: "/repo",
        cwdPolicySummary: "/repo",
        env: { TZ: "UTC" },
        timeoutMs: 1000,
        maxOutputBytes: 4096,
        maxInlineOutputBytes: 1024,
        maxArtifactBytes: 2048
      }
    });

    expect(invocations).toHaveLength(2);
    expect(invocations[0]?.shell).toBe(false);
    expect(invocations[0]?.argv).toEqual(["diff", "--", "README.md"]);
    expect(invocations[1]?.argv).toEqual(["-u", "+%Y"]);
  });

  it("shell keeps injection-like args as literal argv entries", async () => {
    const invocations: Array<{ executablePath: string; argv: string[]; cwd: string; shell: false }> = [];
    const processFactory = createProcessFactory((input) => {
      invocations.push(input);
      return { stdout: "ok\n", stderr: "", code: 0 };
    });
    const executor = new LocalProcessToolExecutor({ processFactory });
    const shellAdapter = new ShellCatalogToolAdapter({ processExecutor: executor });

    await shellAdapter.invoke({
      executionPlan: {
        type: "shell",
        commandId: "local.echo",
        executablePath: "/bin/echo",
        argv: ["safe", "; rm -rf /"],
        cwd: "/repo",
        cwdPolicySummary: "/repo",
        env: {},
        timeoutMs: 1000,
        maxOutputBytes: 4096,
        maxInlineOutputBytes: 1024,
        maxArtifactBytes: 2048
      }
    });

    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.argv).toEqual(["safe", "; rm -rf /"]);
    expect(invocations[0]?.shell).toBe(false);
  });

  it("process executor reports timeout and nonzero exits", async () => {
    const timeoutFactory = createProcessFactory(() => ({ stdout: "", stderr: "", code: null, delayMs: 30 }));
    const timeoutExecutor = new LocalProcessToolExecutor({ processFactory: timeoutFactory });

    await expect(timeoutExecutor.run({
      executablePath: "/bin/echo",
      argv: ["x"],
      cwd: "/repo",
      env: {},
      timeoutMs: 1,
      maxOutputBytes: 1024
    })).rejects.toMatchObject({ reasonCode: "tool_process_timeout" });

    const nonzeroFactory = createProcessFactory(() => ({ stdout: "", stderr: "bad", code: 2 }));
    const nonzeroExecutor = new LocalProcessToolExecutor({ processFactory: nonzeroFactory });
    await expect(nonzeroExecutor.run({
      executablePath: "/bin/echo",
      argv: ["x"],
      cwd: "/repo",
      env: {},
      timeoutMs: 100,
      maxOutputBytes: 1024
    })).rejects.toMatchObject({ reasonCode: "tool_process_nonzero_exit" });
  });

  it("process executor reports cancellation, output flood, and spawn error", async () => {
    const cancelFactory = createProcessFactory(() => ({ stdout: "", stderr: "", code: null, delayMs: 20 }));
    const cancelExecutor = new LocalProcessToolExecutor({ processFactory: cancelFactory });
    const controller = new AbortController();
    const pending = cancelExecutor.run({
      executablePath: "/bin/echo",
      argv: ["x"],
      cwd: "/repo",
      env: {},
      timeoutMs: 1000,
      maxOutputBytes: 1024,
      abortSignal: controller.signal
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ reasonCode: "tool_process_cancelled" });

    const floodFactory = createProcessFactory(() => ({ stdout: "x".repeat(4096), stderr: "", code: 0 }));
    const floodExecutor = new LocalProcessToolExecutor({ processFactory: floodFactory });
    await expect(floodExecutor.run({
      executablePath: "/bin/echo",
      argv: ["x"],
      cwd: "/repo",
      env: {},
      timeoutMs: 100,
      maxOutputBytes: 32
    })).rejects.toMatchObject({ reasonCode: "tool_output_limit_exceeded" });

    const spawnErrorFactory: LocalProcessFactory = {
      spawn() {
        const emitter = new EventEmitter() as EventEmitter & {
          stdout: PassThrough;
          stderr: PassThrough;
          kill: (signal?: NodeJS.Signals) => boolean;
        };
        emitter.stdout = new PassThrough();
        emitter.stderr = new PassThrough();
        emitter.kill = () => true;
        setTimeout(() => {
          emitter.emit("error", new Error("spawn failed"));
        }, 0);
        return emitter;
      }
    };
    const spawnErrorExecutor = new LocalProcessToolExecutor({ processFactory: spawnErrorFactory });
    await expect(spawnErrorExecutor.run({
      executablePath: "/bin/missing",
      argv: [],
      cwd: "/repo",
      env: {},
      timeoutMs: 100,
      maxOutputBytes: 32
    })).rejects.toMatchObject({ reasonCode: "tool_process_spawn_failed" });
  });
});

function baseFetchPlan() {
  return {
    type: "fetch" as const,
    method: "GET" as const,
    url: "https://example.com/path",
    allowedHosts: ["example.com"],
    allowedHeaders: [],
    maxRedirects: 2,
    allowedContentTypes: ["text/plain"],
    captureContent: true,
    timeoutMs: 2000,
    maxResponseBytes: 1024,
    maxInlineOutputBytes: 256,
    maxArtifactBytes: 512
  };
}

function baseWebSearchPlan() {
  return {
    type: "web_search" as const,
    providerId: "fake-search",
    baseUrl: "https://search.example/api",
    query: "switchyard",
    maxResults: 5,
    timeoutMs: 1000,
    maxResponseBytes: 4096,
    maxInlineOutputBytes: 1024,
    maxArtifactBytes: 1024
  };
}

function baseGithubPlan(number: number) {
  return {
    type: "github" as const,
    operation: "get_issue" as const,
    owner: "openai",
    repo: "codex",
    number,
    timeoutMs: 1000,
    maxResponseBytes: 2048,
    maxInlineOutputBytes: 1024,
    maxArtifactBytes: 1024
  };
}

function createProcessFactory(
  scenario: (input: { executablePath: string; argv: string[]; cwd: string; shell: false }) => {
    stdout: string;
    stderr: string;
    code: number | null;
    delayMs?: number;
  }
): LocalProcessFactory {
  return {
    spawn(executablePath, argv, options) {
      const emitter = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        kill: (signal?: NodeJS.Signals) => boolean;
      };
      emitter.stdout = new PassThrough();
      emitter.stderr = new PassThrough();
      let closed = false;

      const result = scenario({ executablePath, argv, cwd: options.cwd, shell: options.shell });
      const delay = result.delayMs ?? 0;
      setTimeout(() => {
        if (closed) {
          return;
        }
        if (result.stdout.length > 0) {
          emitter.stdout.write(result.stdout);
        }
        if (result.stderr.length > 0) {
          emitter.stderr.write(result.stderr);
        }
        emitter.stdout.end();
        emitter.stderr.end();
        emitter.emit("close", result.code);
      }, delay);

      emitter.kill = () => {
        closed = true;
        emitter.emit("close", null);
        return true;
      };

      return emitter;
    }
  };
}
