import type { Run } from "@switchyard/contracts";
import type { RunService } from "./run-service.js";

export class RunLauncherService {
  constructor(private readonly runService: RunService) {}

  launch(run: Run): void {
    queueMicrotask(() => {
      void this.runService.startRun(run.id);
    });
  }
}
