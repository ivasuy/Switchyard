import type { Artifact } from "@switchyard/contracts";
import type { ToolAdapter } from "@switchyard/core";

export class FakeEchoToolAdapter implements ToolAdapter {
  readonly id = "fake_echo";
  invocationCount = 0;

  async check(_config?: Record<string, unknown>) {
    return { ok: true };
  }

  async invoke(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.invocationCount += 1;
    if (input["fail"] === true) {
      throw new Error("fake echo forced failure");
    }
    const text = input["text"];
    if (typeof text !== "string") {
      throw new Error("fake_echo requires input.text");
    }
    return { echo: text };
  }

  async cancel(): Promise<void> {
    return;
  }

  async artifacts(): Promise<Artifact[]> {
    return [];
  }
}
