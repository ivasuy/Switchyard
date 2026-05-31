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
});

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
