import { AdapterProtocolError, type RuntimeAdapter } from "@switchyard/core";

export interface RuntimeAdapterContractInput {
  adapter: RuntimeAdapter;
  runtime: string;
  provider: string;
  model: string;
  adapterType: "process" | "http" | "acpx";
  cwd?: string;
  task?: string;
}

export async function runRuntimeAdapterContract(input: RuntimeAdapterContractInput): Promise<void> {
  const { adapter } = input;
  if (!adapter.manifest.runtimeModeSlug) {
    throw new Error("adapter manifest must include runtimeModeSlug");
  }

  const check = await adapter.check({ timeoutMs: 1000, maxDiagnosticBytes: 4096 });
  if (typeof check.ok !== "boolean") {
    throw new Error("adapter check must return { ok: boolean }");
  }

  const session = await adapter.start({
    runId: "run_contract",
    runtime: input.runtime,
    runtimeMode: adapter.manifest.runtimeModeSlug,
    provider: input.provider,
    model: input.model,
    cwd: input.cwd ?? "/repo",
    task: input.task ?? "contract test run",
    metadata: {}
  });
  if (!session.sessionId || session.sessionId.length === 0) {
    throw new Error("adapter start must return sessionId");
  }

  const events = [];
  for await (const event of adapter.events({ ...session, runId: "run_contract" })) {
    events.push(event);
  }
  const terminal = events.filter((event) => event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled");
  if (terminal.length !== 1) {
    throw new Error(`adapter must emit exactly one terminal event, got ${terminal.length}`);
  }

  const supportsInput = adapter.manifest.capabilities.includes("run.input" as never);
  if (supportsInput) {
    await adapter.send({ ...session, runId: "run_contract" }, { text: "continue" });
  } else {
    let threwProtocol = false;
    try {
      await adapter.send({ ...session, runId: "run_contract" }, { text: "continue" });
    } catch (error) {
      threwProtocol = error instanceof AdapterProtocolError;
    }
    if (!threwProtocol) {
      throw new Error("adapter without run.input capability must throw AdapterProtocolError from send()");
    }
  }

  await adapter.cancel({ ...session, runId: "run_contract" });
  await adapter.cancel({ ...session, runId: "run_contract" });

  const artifacts = await adapter.artifacts({ ...session, runId: "run_contract" });
  for (const artifact of artifacts) {
    if (artifact.path.startsWith("/") || artifact.path.includes("..") || artifact.path.includes("\\")) {
      throw new Error(`artifact path must be safe relative path, got ${artifact.path}`);
    }
    if (artifact.type === "transcript") {
      const content = artifact.metadata["content"];
      if (content !== undefined && typeof content !== "string") {
        throw new Error("transcript artifact metadata.content must be a string when present");
      }
    }
  }
}
