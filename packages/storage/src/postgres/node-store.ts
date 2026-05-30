import type { ConnectedNode } from "@switchyard/contracts";
import type { NodeStore } from "@switchyard/core";

export class PostgresNodeStore implements NodeStore {
  private readonly items = new Map<string, ConnectedNode>();

  async upsert(node: ConnectedNode): Promise<ConnectedNode> {
    this.items.set(node.id, node);
    return node;
  }

  async get(id: string): Promise<ConnectedNode | undefined> {
    return this.items.get(id);
  }

  async list(filter?: { status?: ConnectedNode["status"]; mode?: ConnectedNode["mode"] }): Promise<ConnectedNode[]> {
    return [...this.items.values()].filter((node) => {
      if (filter?.status && node.status !== filter.status) return false;
      if (filter?.mode && node.mode !== filter.mode) return false;
      return true;
    });
  }

  async markOffline(id: string, at: string): Promise<ConnectedNode | undefined> {
    const node = this.items.get(id);
    if (!node) return undefined;
    const updated: ConnectedNode = { ...node, status: "offline", updatedAt: at };
    this.items.set(id, updated);
    return updated;
  }

  async listEligible(input: { runtimeMode: string; now: string; requiredCapabilities?: string[] }): Promise<ConnectedNode[]> {
    const required = input.requiredCapabilities ?? [`runtime.${input.runtimeMode}`];
    return [...this.items.values()].filter((node) => {
      if (node.status !== "online") return false;
      if (node.heartbeatExpiresAt && node.heartbeatExpiresAt < input.now) return false;
      return required.every((capability) => node.capabilities.includes(capability) || node.capabilities.includes(input.runtimeMode));
    });
  }
}
