import type { ConnectedNode } from "@switchyard/contracts";

export interface ListNodesFilter {
  status?: ConnectedNode["status"];
  mode?: ConnectedNode["mode"];
}

export interface EligibleNodeFilter {
  runtimeMode: string;
  now: string;
  requiredCapabilities?: string[];
}

export interface NodeStore {
  upsert(node: ConnectedNode): Promise<ConnectedNode>;
  get(id: string): Promise<ConnectedNode | undefined>;
  list(filter?: ListNodesFilter): Promise<ConnectedNode[]>;
  markOffline(id: string, at: string): Promise<ConnectedNode | undefined>;
  listEligible(input: EligibleNodeFilter): Promise<ConnectedNode[]>;
}
