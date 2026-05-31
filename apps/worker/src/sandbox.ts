import { ProductionHostedSandboxExecutor, type SandboxProcessFactory, type SandboxPtyFactory } from "@switchyard/adapters";
import { HostedSandboxService, type RuntimeLogger } from "@switchyard/core";
import { FakeHostedSandboxExecutor } from "@switchyard/testkit";
import type { WorkerConfig } from "./config.js";

export interface WorkerSandboxFactoryDeps {
  processFactory?: SandboxProcessFactory;
  ptyFactory?: SandboxPtyFactory;
  logger?: RuntimeLogger;
}

export function createWorkerHostedSandboxService(
  config: WorkerConfig,
  deps: WorkerSandboxFactoryDeps = {}
): HostedSandboxService {
  const executor = config.sandbox.realExecution.mode === "enabled"
    ? new ProductionHostedSandboxExecutor({
      ...(deps.processFactory ? { processFactory: deps.processFactory } : {}),
      ...(deps.ptyFactory ? { ptyFactory: deps.ptyFactory } : {}),
      ...(deps.logger ? { logger: deps.logger } : {})
    })
    : new FakeHostedSandboxExecutor();

  return new HostedSandboxService({
    config: config.sandbox,
    executor
  });
}
