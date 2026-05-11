import type { Artifact } from "@switchyard/contracts";

export interface ToolAdapter {
  readonly id: string;
  check(config?: Record<string, unknown>): Promise<{ ok: boolean; message?: string }>;
  invoke(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  cancel(invocationId: string): Promise<void>;
  artifacts(invocationId: string): Promise<Artifact[]>;
}
