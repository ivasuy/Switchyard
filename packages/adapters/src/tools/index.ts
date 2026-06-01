import { AdapterProtocolError, type ToolAdapter } from "@switchyard/core";
import { FakeEchoToolAdapter } from "@switchyard/testkit";
import { FetchToolAdapter, type FetchToolAdapterOptions } from "./fetch-tool-adapter.js";
import { GithubToolAdapter, type GithubClient } from "./github-tool-adapter.js";
import { LocalProcessToolExecutor, type LocalProcessFactory } from "./local-process-tool-executor.js";
import { RepoToolAdapter } from "./repo-tool-adapter.js";
import { ShellCatalogToolAdapter } from "./shell-catalog-tool-adapter.js";
import { WebSearchToolAdapter, type SearchClient } from "./web-search-tool-adapter.js";

export interface ShellCatalogCommandConfig {
  executablePath: string;
  fixedArgs: string[];
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface HostedToolAdapterConfig {
  placement: "hosted";
  mode: "fake" | "real";
  fetch: {
    fetchImpl?: typeof fetch;
    lookup?: FetchToolAdapterOptions["lookup"];
  };
  webSearch: {
    client?: SearchClient;
    fetchImpl?: typeof fetch;
  };
  github: {
    token?: string;
    client?: GithubClient;
    fetchImpl?: typeof fetch;
  };
  shell: {
    catalog: Record<string, ShellCatalogCommandConfig>;
  };
}

export interface NodeToolAdapterConfig {
  placement: "connected_local_node";
  fetch: {
    fetchImpl?: typeof fetch;
    lookup?: FetchToolAdapterOptions["lookup"];
  };
  webSearch: {
    client?: SearchClient;
    fetchImpl?: typeof fetch;
  };
  github: {
    token?: string;
    client?: GithubClient;
    fetchImpl?: typeof fetch;
  };
  repo: {
    gitBinary: string;
  };
  shell: {
    catalog: Record<string, ShellCatalogCommandConfig>;
  };
}

export interface HostedToolAdapterDeps {
  searchClient?: SearchClient;
  githubClient?: GithubClient;
  processFactory?: LocalProcessFactory;
}

export interface NodeToolAdapterDeps {
  searchClient?: SearchClient;
  githubClient?: GithubClient;
  processFactory?: LocalProcessFactory;
}

export function buildHostedToolAdapters(
  config: HostedToolAdapterConfig,
  deps: HostedToolAdapterDeps = {}
): Map<string, ToolAdapter> {
  if (config.placement !== "hosted") {
    throw new Error("hosted_tool_adapter_config_invalid");
  }

  const processExecutor = new LocalProcessToolExecutor({
    ...(deps.processFactory ? { processFactory: deps.processFactory } : {})
  });
  const searchClient = config.mode === "fake"
    ? (deps.searchClient ?? createFakeSearchClient())
    : deps.searchClient;
  const githubClient = config.mode === "fake"
    ? (deps.githubClient ?? createFakeGithubClient())
    : deps.githubClient;
  const fetchOptions: FetchToolAdapterOptions = {};
  const fetchImpl = config.fetch.fetchImpl ?? (config.mode === "fake" ? createFakeFetchImpl() : undefined);
  const lookup = config.fetch.lookup ?? (config.mode === "fake" ? createFakeLookup() : undefined);
  if (fetchImpl) {
    fetchOptions.fetchImpl = fetchImpl;
  }
  if (lookup) {
    fetchOptions.lookup = lookup;
  }
  const webSearch = new WebSearchToolAdapter({
    ...(searchClient ? { client: searchClient } : {}),
    ...(config.webSearch.fetchImpl ? { fetchImpl: config.webSearch.fetchImpl } : {})
  });
  const githubOptions: {
    token?: string;
    client?: GithubClient;
    fetchImpl?: typeof fetch;
  } = {};
  if (config.github.token) {
    githubOptions.token = config.github.token;
  }
  if (githubClient) {
    githubOptions.client = githubClient;
  }
  if (config.github.fetchImpl) {
    githubOptions.fetchImpl = config.github.fetchImpl;
  }
  const github = new GithubToolAdapter(githubOptions);

  return new Map<string, ToolAdapter>([
    ["fetch", new FetchToolAdapter(fetchOptions)],
    ["web_search", webSearch],
    ["github", github],
    ["shell", new ShellCatalogToolAdapter({ processExecutor })],
    ["fake_echo", new FakeEchoToolAdapter()]
  ]);
}

export function buildNodeToolAdapters(
  config: NodeToolAdapterConfig,
  deps: NodeToolAdapterDeps = {}
): Map<string, ToolAdapter> {
  assertNodeConfig(config);
  const processExecutor = new LocalProcessToolExecutor({
    ...(deps.processFactory ? { processFactory: deps.processFactory } : {})
  });
  const nodeFetchOptions: FetchToolAdapterOptions = {};
  if (config.fetch.fetchImpl) {
    nodeFetchOptions.fetchImpl = config.fetch.fetchImpl;
  }
  if (config.fetch.lookup) {
    nodeFetchOptions.lookup = config.fetch.lookup;
  }
  const nodeGithubOptions: {
    token?: string;
    client?: GithubClient;
    fetchImpl?: typeof fetch;
  } = {};
  if (config.github.token) {
    nodeGithubOptions.token = config.github.token;
  }
  const resolvedNodeGithubClient = deps.githubClient ?? config.github.client;
  if (resolvedNodeGithubClient) {
    nodeGithubOptions.client = resolvedNodeGithubClient;
  }
  if (config.github.fetchImpl) {
    nodeGithubOptions.fetchImpl = config.github.fetchImpl;
  }
  return new Map<string, ToolAdapter>([
    ["fetch", new FetchToolAdapter(nodeFetchOptions)],
    ["web_search", new WebSearchToolAdapter({
      ...(deps.searchClient ?? config.webSearch.client ? { client: deps.searchClient ?? config.webSearch.client } : {}),
      ...(config.webSearch.fetchImpl ? { fetchImpl: config.webSearch.fetchImpl } : {})
    })],
    ["github", new GithubToolAdapter(nodeGithubOptions)],
    ["repo", new RepoToolAdapter({ processExecutor })],
    ["shell", new ShellCatalogToolAdapter({ processExecutor })],
    ["fake_echo", new FakeEchoToolAdapter()]
  ]);
}

function assertNodeConfig(config: NodeToolAdapterConfig): void {
  const record = config as unknown as Record<string, unknown>;
  if (config.placement !== "connected_local_node") {
    throw new Error("node_tool_adapter_config_invalid");
  }
  if ("hostedRuntimeAllowlist" in record || "hostedRealRuntimeExecution" in record || "providerRuntimeActivation" in record) {
    throw new Error("node_tool_adapter_config_invalid");
  }
}

function createFakeLookup(): NonNullable<FetchToolAdapterOptions["lookup"]> {
  return (async (hostname: string) => {
    if (hostname.includes("private")) {
      return [{ address: "10.0.0.5", family: 4 }];
    }
    return [{ address: "93.184.216.34", family: 4 }];
  }) as unknown as NonNullable<FetchToolAdapterOptions["lookup"]>;
}

function createFakeFetchImpl(): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    if (url.includes("timeout")) {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          (error as Error & { name: string }).name = "AbortError";
          reject(error);
        }, { once: true });
      });
    }
    if (url.includes("redirect-private")) {
      return new Response("", {
        status: 302,
        headers: { location: "https://private.example/internal" }
      });
    }
    if (url.includes("oversized")) {
      return new Response("x".repeat(128_000), {
        status: 200,
        headers: { "content-type": "text/plain" }
      });
    }
    return new Response("fake-fetch-ok", {
      status: 200,
      headers: { "content-type": "text/plain" }
    });
  };
}

function createFakeSearchClient(): SearchClient {
  return {
    async search(input) {
      if (input.query.includes("provider-unavailable")) {
        throw new AdapterProtocolError("provider unavailable", { reasonCode: "web_search_provider_unconfigured" });
      }
      if (input.query.includes("zero-results")) {
        return [];
      }
      if (input.query.includes("oversized")) {
        return [{ title: "x", url: "https://example.com", snippet: "y".repeat(input.maxResponseBytes) }];
      }
      return [
        { title: "Result 1", url: "https://example.com/1", snippet: "Fake result one" },
        { title: "Result 2", url: "https://example.com/2", snippet: "Fake result two" }
      ];
    }
  };
}

function createFakeGithubClient(): GithubClient {
  return {
    async call(operation, plan) {
      if (plan.repo.includes("rate-limit")) {
        throw new AdapterProtocolError("rate limited", { reasonCode: "github_rate_limited" });
      }
      if (plan.repo.includes("denied")) {
        throw new AdapterProtocolError("repo denied", { reasonCode: "github_repo_not_allowlisted" });
      }
      return {
        operation,
        owner: plan.owner,
        repo: plan.repo,
        ok: true
      };
    }
  };
}

export * from "./fetch-tool-adapter.js";
export * from "./web-search-tool-adapter.js";
export * from "./github-tool-adapter.js";
export * from "./local-process-tool-executor.js";
export * from "./repo-tool-adapter.js";
export * from "./shell-catalog-tool-adapter.js";
