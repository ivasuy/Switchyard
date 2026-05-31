import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ToolExecutionPlan } from "../src/ports/policy.js";
import {
  LocalPolicyGate,
  createDisabledRealToolPolicyConfig,
  type ResolvedRealToolPolicyConfig
} from "../src/services/local-policy-gate.js";

function enabledConfig(): ResolvedRealToolPolicyConfig {
  const base = createDisabledRealToolPolicyConfig();
  return {
    ...base,
    global: {
      ...base.global,
      enabled: true
    },
    fetch: {
      ...base.fetch,
      enabled: true,
      allowedHosts: ["example.com"],
      allowedHeaders: ["accept"],
      allowedContentTypes: ["text/plain", "application/json"],
      maxResponseBytes: 1024 * 32
    },
    webSearch: {
      ...base.webSearch,
      enabled: true,
      providerId: "fake-search",
      baseUrl: "https://search.example/api",
      maxResults: 5
    },
    github: {
      ...base.github,
      enabled: true,
      token: "ghp_secret",
      allowedRepos: ["openai/codex"]
    },
    repo: {
      ...base.repo,
      enabled: true,
      gitBinary: "/usr/bin/git",
      allowedCwdPrefixes: ["/repo"],
      maxPaths: 8
    },
    shell: {
      ...base.shell,
      enabled: true,
      allowedCwdPrefixes: ["/repo"],
      catalog: {
        "local.date.utc": {
          commandId: "local.date.utc",
          executablePath: "/bin/date",
          argv: ["-u"],
          allowedCwdPrefixes: ["/repo"],
          env: { TZ: "UTC" },
          maxArgs: 4
        }
      }
    }
  };
}

function hashPlan(plan: ToolExecutionPlan): string {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

describe("real tool policy", () => {
  it("denies real tools when globally disabled", async () => {
    const gate = new LocalPolicyGate();
    const decision = await gate.decideTool({
      type: "fetch",
      input: { url: "https://example.com", method: "GET" }
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reasonCode).toBe("tool_real_tools_disabled");
  });

  it("always denies browser as unshipped", async () => {
    const gate = new LocalPolicyGate(enabledConfig());
    const decision = await gate.decideTool({
      type: "browser",
      input: { action: "open", url: "https://example.com" }
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reasonCode).toBe("browser_tool_unshipped");
  });

  it("returns approval-required fetch execution plan", async () => {
    const gate = new LocalPolicyGate(enabledConfig());
    const decision = await gate.decideTool({
      type: "fetch",
      input: { url: "https://example.com/path", method: "GET", captureContent: true }
    });

    expect(decision.decision).toBe("approval_required");
    if (decision.decision !== "approval_required") {
      throw new Error("expected approval_required");
    }
    expect(decision.approvalType).toBe("before_external_web_action");
    expect(decision.executionPlan.type).toBe("fetch");
    expect(decision.executionPlan.url).toContain("example.com");
  });

  it("rejects private-looking fetch targets", async () => {
    const gate = new LocalPolicyGate(enabledConfig());
    const decision = await gate.decideTool({
      type: "fetch",
      input: { url: "http://127.0.0.1/path", method: "GET" }
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reasonCode).toBe("fetch_private_network_denied");
  });

  it("rejects web search when provider config is missing", async () => {
    const config = enabledConfig();
    config.webSearch.providerId = undefined;
    const gate = new LocalPolicyGate(config);
    const decision = await gate.decideTool({
      type: "web_search",
      input: { query: "switchyard" }
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reasonCode).toBe("web_search_provider_unconfigured");
  });

  it("returns github execution plan without token exposure", async () => {
    const gate = new LocalPolicyGate(enabledConfig());
    const decision = await gate.decideTool({
      type: "github",
      input: {
        operation: "get_issue",
        owner: "openai",
        repo: "codex",
        number: 123
      }
    });
    expect(decision.decision).toBe("approval_required");
    if (decision.decision !== "approval_required") {
      throw new Error("expected approval_required");
    }
    const json = JSON.stringify(decision);
    expect(json).not.toContain("ghp_secret");
  });

  it("denies github repo outside allowlist", async () => {
    const gate = new LocalPolicyGate(enabledConfig());
    const decision = await gate.decideTool({
      type: "github",
      input: { operation: "get_issue", owner: "evil", repo: "fork", number: 1 }
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reasonCode).toBe("github_repo_not_allowlisted");
  });

  it("returns repo and shell with local-process approval type", async () => {
    const gate = new LocalPolicyGate(enabledConfig());
    const repo = await gate.decideTool({
      type: "repo",
      input: { operation: "diff", cwd: "/repo", pathspec: ["packages/core/src"] }
    });
    const shell = await gate.decideTool({
      type: "shell",
      input: { commandId: "local.date.utc", cwd: "/repo", args: ["+%Y"] }
    });

    expect(repo.decision).toBe("approval_required");
    expect(shell.decision).toBe("approval_required");
    if (repo.decision !== "approval_required" || shell.decision !== "approval_required") {
      throw new Error("expected approval_required");
    }
    expect(repo.approvalType).toBe("before_local_process_execution");
    expect(shell.approvalType).toBe("before_local_process_execution");
    expect(repo.executionPlan.type).toBe("repo");
    expect(shell.executionPlan.type).toBe("shell");
  });

  it("denies repo traversal and unknown shell command", async () => {
    const gate = new LocalPolicyGate(enabledConfig());
    const repo = await gate.decideTool({
      type: "repo",
      input: { operation: "diff", cwd: "/repo", pathspec: ["../secret"] }
    });
    const shell = await gate.decideTool({
      type: "shell",
      input: { commandId: "unknown", cwd: "/repo" }
    });
    expect(repo.decision).toBe("deny");
    expect(repo.reasonCode).toBe("repo_operation_denied");
    expect(shell.decision).toBe("deny");
    expect(shell.reasonCode).toBe("shell_command_not_configured");
  });

  it("preserves fake_echo safe and risky behavior", async () => {
    const gate = new LocalPolicyGate(enabledConfig());
    const safe = await gate.decideTool({ type: "fake_echo", input: { text: "ok" } });
    const risky = await gate.decideTool({ type: "fake_echo", input: { text: "x", requiresApproval: true } });
    expect(safe.decision).toBe("allow");
    expect(risky.decision).toBe("approval_required");
  });

  it("builds stable hashable plans without secrets", async () => {
    const gate = new LocalPolicyGate(enabledConfig());
    const decisions = await Promise.all([
      gate.decideTool({ type: "fetch", input: { url: "https://example.com", method: "GET" } }),
      gate.decideTool({ type: "web_search", input: { query: "switchyard", maxResults: 2 } }),
      gate.decideTool({ type: "github", input: { operation: "get_issue", owner: "openai", repo: "codex", number: 9 } }),
      gate.decideTool({ type: "repo", input: { operation: "status", cwd: "/repo" } }),
      gate.decideTool({ type: "shell", input: { commandId: "local.date.utc", cwd: "/repo" } })
    ]);

    for (const decision of decisions) {
      expect(decision.decision).toBe("approval_required");
      if (decision.decision !== "approval_required") {
        continue;
      }
      const hash = hashPlan(decision.executionPlan);
      expect(hash).toHaveLength(64);
      const json = JSON.stringify(decision.executionPlan);
      expect(json).not.toContain("ghp_secret");
      expect(json).not.toContain("apiKey");
      expect(json).not.toContain("authorization");
      expect(json).not.toContain("cookie");
    }
  });
});
