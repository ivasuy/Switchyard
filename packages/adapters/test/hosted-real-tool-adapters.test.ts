import { describe, expect, it } from "vitest";
import { AdapterProtocolError } from "@switchyard/core";
import {
  buildHostedToolAdapters,
  buildNodeToolAdapters,
  type HostedToolAdapterConfig,
  type NodeToolAdapterConfig
} from "../src/index.js";

describe("hosted real tool adapter factories", () => {
  it("buildHostedToolAdapters exposes hosted-safe tool set", async () => {
    const config: HostedToolAdapterConfig = {
      placement: "hosted",
      mode: "fake",
      fetch: {},
      webSearch: {},
      github: { token: "ghp_fake" },
      shell: {
        catalog: {
          "safe.echo": {
            executablePath: "/bin/echo",
            fixedArgs: [],
            env: {},
            timeoutMs: 1000,
            maxOutputBytes: 2048
          }
        }
      }
    };

    const adapters = buildHostedToolAdapters(config);
    expect(adapters.has("fetch")).toBe(true);
    expect(adapters.has("web_search")).toBe(true);
    expect(adapters.has("github")).toBe(true);
    expect(adapters.has("shell")).toBe(true);
    expect(adapters.has("fake_echo")).toBe(true);
    expect(adapters.has("repo")).toBe(false);
    expect(adapters.has("browser")).toBe(false);

    const fetchAdapter = adapters.get("fetch");
    const result = await fetchAdapter?.invoke({
      executionPlan: {
        type: "fetch",
        method: "GET",
        url: "https://example.com/health",
        allowedHosts: ["example.com"],
        allowedHeaders: [],
        maxRedirects: 1,
        allowedContentTypes: ["text/plain"],
        captureContent: false,
        timeoutMs: 1000,
        maxResponseBytes: 2048,
        maxInlineOutputBytes: 1024,
        maxArtifactBytes: 1024
      }
    });
    expect((result?.summary as Record<string, unknown>)?.status).toBe(200);
  });

  it("buildNodeToolAdapters rejects hosted or worker-shaped config", () => {
    const workerLike = {
      hostedRuntimeAllowlist: ["fake.deterministic"],
      hostedRealRuntimeExecution: "enabled",
      postgresUrl: "postgres://example",
      redisUrl: "redis://example"
    } as unknown as NodeToolAdapterConfig;
    expect(() => buildNodeToolAdapters(workerLike)).toThrow("node_tool_adapter_config_invalid");

    const hostedShape = {
      placement: "hosted",
      mode: "fake",
      shell: { catalog: {} }
    } as unknown as NodeToolAdapterConfig;
    expect(() => buildNodeToolAdapters(hostedShape)).toThrow("node_tool_adapter_config_invalid");
  });

  it("node builder includes repo adapter and hosted builder does not", async () => {
    const nodeConfig: NodeToolAdapterConfig = {
      placement: "connected_local_node",
      fetch: {},
      webSearch: {},
      github: { token: "ghp_node" },
      repo: { gitBinary: "git" },
      shell: {
        catalog: {
          "safe.echo": {
            executablePath: "/bin/echo",
            fixedArgs: [],
            env: {},
            timeoutMs: 1000,
            maxOutputBytes: 2048
          }
        }
      }
    };

    const nodeAdapters = buildNodeToolAdapters(nodeConfig);
    expect(nodeAdapters.has("repo")).toBe(true);

    const hostedAdapters = buildHostedToolAdapters({
      placement: "hosted",
      mode: "fake",
      fetch: {},
      webSearch: {},
      github: { token: "ghp_fake" },
      shell: { catalog: {} }
    });
    expect(hostedAdapters.has("repo")).toBe(false);

    const browserInvoke = async () => {
      const browser = hostedAdapters.get("browser");
      if (!browser) {
        throw new AdapterProtocolError("browser_tool_unshipped", { reasonCode: "browser_tool_unshipped" });
      }
      return browser.invoke({ action: "open" });
    };
    await expect(browserInvoke()).rejects.toMatchObject({ reasonCode: "browser_tool_unshipped" });
  });
});
