import type { NodePolicy } from "@switchyard/contracts";

export interface NodeAppConfig {
  serverUrl: string;
  sharedToken?: string;
  nodeId?: string;
  capabilities: string[];
  policy: NodePolicy;
}

export function loadNodeConfig(env: NodeJS.ProcessEnv = process.env): NodeAppConfig {
  const config: NodeAppConfig = {
    serverUrl: env["SWITCHYARD_SERVER_URL"] ?? "http://127.0.0.1:4646",
    capabilities: (env["SWITCHYARD_NODE_CAPABILITIES"] ?? "runtime.fake.deterministic").split(",").map((value) => value.trim()).filter(Boolean),
    policy: {
      allowRuntimeModes: (env["SWITCHYARD_NODE_ALLOW_RUNTIME_MODES"] ?? "fake.deterministic").split(",").map((value) => value.trim()).filter(Boolean),
      denyAdapterTypes: [],
      allowCwdPrefixes: (env["SWITCHYARD_NODE_ALLOW_CWD_PREFIXES"] ?? "/repo").split(",").map((value) => value.trim()).filter(Boolean),
      allowEventTypes: [],
      artifactSync: "full"
    }
  };
  const sharedToken = env["SWITCHYARD_NODE_SHARED_TOKEN"]?.trim();
  const nodeId = env["SWITCHYARD_NODE_ID"]?.trim();
  if (sharedToken) config.sharedToken = sharedToken;
  if (nodeId) config.nodeId = nodeId;
  return config;
}
