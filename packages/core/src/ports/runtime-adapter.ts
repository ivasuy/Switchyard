import type {
  AdapterType,
  Artifact,
  RuntimeCapability,
  RuntimeLimitation,
  RuntimeModeKind,
  RuntimePlacementFacts,
  SwitchyardEvent
} from "@switchyard/contracts";

export interface RuntimeAdapterCheck {
  ok: boolean;
  message?: string;
  details?: Record<string, unknown>;
}

export interface RuntimeAdapterManifest {
  adapterId: string;
  providerId: string;
  runtimeId: string;
  runtimeModeId: string;
  runtimeModeSlug: string;
  name: string;
  adapterType: AdapterType;
  kind: RuntimeModeKind;
  capabilities: RuntimeCapability[];
  limitations: RuntimeLimitation[];
  placement: RuntimePlacementFacts;
  docsPath?: string;
  check: {
    strategy: "none" | "binary_version" | "binary_version_and_model_catalog" | "http_health" | "custom";
    required: string[];
    optional: string[];
  };
}

export interface RuntimeStartResult {
  sessionId: string;
  externalSessionKey?: string;
  processId?: number;
}

export interface RuntimeAdapter {
  readonly id: string;
  readonly manifest: RuntimeAdapterManifest;
  check(config?: Record<string, unknown>): Promise<RuntimeAdapterCheck>;
  start(request: Record<string, unknown>): Promise<RuntimeStartResult>;
  send(session: Record<string, unknown>, input: Record<string, unknown>): Promise<void>;
  cancel(session: Record<string, unknown>): Promise<void>;
  events(session: Record<string, unknown>): AsyncIterable<SwitchyardEvent>;
  tools(session: Record<string, unknown>): Promise<string[]>;
  artifacts(session: Record<string, unknown>): Promise<Artifact[]>;
}
