import { URL } from "node:url";
import type { ArtifactContentStore } from "@switchyard/core";
import { LocalObjectArtifactContentStore } from "./local-object-artifact-content-store.js";
import { MemoryArtifactContentStore } from "./memory-artifact-content-store.js";
import { ObjectArtifactContentStore } from "./object-artifact-content-store.js";
import { createS3CompatibleObjectClient, type S3CompatibleObjectClient } from "./s3-compatible-object-client.js";

export type DeploymentMode = "local" | "test" | "staging" | "production";
export type ObjectStoreBackend = "memory" | "local" | "s3-compatible";
export type ObjectStoreProbeMode = "write_read_delete" | "disabled";

export class ObjectStoreConfigError extends Error {
  constructor(
    readonly code: string,
    readonly variable: string,
    readonly redactedConfig: Record<string, unknown>
  ) {
    super(code);
  }
}

export interface RedactedObjectStoreSummary {
  backend: ObjectStoreBackend;
  endpointScheme?: string;
  endpointHost?: string;
  region?: string;
  bucket?: string;
  keyPrefix?: string;
  forcePathStyle?: boolean;
  hasAccessKeyId?: boolean;
  hasSecretAccessKey?: boolean;
  requestTimeoutMs?: number;
  probe: ObjectStoreProbeMode;
  warningCodes?: string[];
}

interface BaseObjectStoreConfig {
  backend: ObjectStoreBackend;
  keyPrefix: string;
  requestTimeoutMs: number;
  probe: ObjectStoreProbeMode;
  redactedSummary: RedactedObjectStoreSummary;
}

export interface MemoryObjectStoreConfig extends BaseObjectStoreConfig {
  backend: "memory";
}

export interface LocalObjectStoreConfig extends BaseObjectStoreConfig {
  backend: "local";
  directory: string;
}

export interface S3CompatibleObjectStoreConfig extends BaseObjectStoreConfig {
  backend: "s3-compatible";
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export type ResolvedObjectStoreConfig =
  | MemoryObjectStoreConfig
  | LocalObjectStoreConfig
  | S3CompatibleObjectStoreConfig;

export type ProbeableArtifactContentStore = ArtifactContentStore & {
  probe: () => Promise<{ ok: true }>;
};

const BACKENDS = new Set<ObjectStoreBackend>(["memory", "local", "s3-compatible"]);
const DEFAULT_TIMEOUT_MS = 5000;

export function resolveObjectStoreConfig(input: {
  env?: NodeJS.ProcessEnv;
  deploymentMode: DeploymentMode;
}): ResolvedObjectStoreConfig {
  const env = input.env ?? process.env;
  const deploymentMode = input.deploymentMode;
  const backendValue = optional(env["SWITCHYARD_OBJECT_STORE_BACKEND"]);
  const objectStoreDir = optional(env["SWITCHYARD_OBJECT_STORE_DIR"]);

  const backend = resolveBackend(backendValue, objectStoreDir, deploymentMode);
  const keyPrefix = parseKeyPrefix(optional(env["SWITCHYARD_OBJECT_STORE_KEY_PREFIX"]) ?? "artifacts");
  const requestTimeoutMs = parsePositiveInt(
    optional(env["SWITCHYARD_OBJECT_STORE_REQUEST_TIMEOUT_MS"]) ?? String(DEFAULT_TIMEOUT_MS),
    "SWITCHYARD_OBJECT_STORE_REQUEST_TIMEOUT_MS",
    { backend, keyPrefix, probe: "write_read_delete" }
  );
  const probe = parseProbeMode(optional(env["SWITCHYARD_OBJECT_STORE_PROBE"]), deploymentMode, {
    backend,
    keyPrefix,
    requestTimeoutMs,
    probe: "write_read_delete"
  });

  if (backend === "memory") {
    const redactedSummary = {
      backend,
      keyPrefix,
      requestTimeoutMs,
      probe
    } satisfies RedactedObjectStoreSummary;
    return {
      backend,
      keyPrefix,
      requestTimeoutMs,
      probe,
      redactedSummary
    };
  }

  if (backend === "local") {
    if (!objectStoreDir) {
      throw configRequired("SWITCHYARD_OBJECT_STORE_DIR", {
        backend,
        keyPrefix,
        requestTimeoutMs,
        probe
      });
    }
    const redactedSummary = {
      backend,
      keyPrefix,
      requestTimeoutMs,
      probe
    } satisfies RedactedObjectStoreSummary;
    return {
      backend,
      directory: objectStoreDir,
      keyPrefix,
      requestTimeoutMs,
      probe,
      redactedSummary
    };
  }

  const endpoint = required("SWITCHYARD_OBJECT_STORE_ENDPOINT", env, {
    backend,
    keyPrefix,
    requestTimeoutMs,
    probe
  });
  const region = required("SWITCHYARD_OBJECT_STORE_REGION", env, {
    backend,
    keyPrefix,
    requestTimeoutMs,
    probe
  });
  const bucket = required("SWITCHYARD_OBJECT_STORE_BUCKET", env, {
    backend,
    keyPrefix,
    requestTimeoutMs,
    probe
  });
  const accessKeyId = required("SWITCHYARD_OBJECT_STORE_ACCESS_KEY_ID", env, {
    backend,
    keyPrefix,
    requestTimeoutMs,
    probe
  });
  const secretAccessKey = required("SWITCHYARD_OBJECT_STORE_SECRET_ACCESS_KEY", env, {
    backend,
    keyPrefix,
    requestTimeoutMs,
    probe
  });
  const forcePathStyle = parseBoolean(optional(env["SWITCHYARD_OBJECT_STORE_FORCE_PATH_STYLE"]), true, "SWITCHYARD_OBJECT_STORE_FORCE_PATH_STYLE", {
    backend,
    keyPrefix,
    requestTimeoutMs,
    probe
  });

  const parsedEndpoint = parseEndpoint(endpoint, deploymentMode, {
    backend,
    keyPrefix,
    requestTimeoutMs,
    probe,
    region,
    bucket,
    forcePathStyle,
    hasAccessKeyId: true,
    hasSecretAccessKey: true
  });

  const redactedSummary: RedactedObjectStoreSummary = {
    backend,
    endpointScheme: parsedEndpoint.protocol.replace(/:$/, ""),
    endpointHost: parsedEndpoint.host,
    region,
    bucket,
    keyPrefix,
    forcePathStyle,
    hasAccessKeyId: true,
    hasSecretAccessKey: true,
    requestTimeoutMs,
    probe,
    ...(objectStoreDir ? { warningCodes: ["object_store_dir_ignored"] } : {})
  };

  return {
    backend,
    endpoint: `${parsedEndpoint.protocol}//${parsedEndpoint.host}`,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle,
    keyPrefix,
    requestTimeoutMs,
    probe,
    redactedSummary
  };
}

export function createArtifactContentStoreFromObjectConfig(
  config: ResolvedObjectStoreConfig,
  options?: { s3Client?: S3CompatibleObjectClient }
): ProbeableArtifactContentStore {
  if (config.backend === "memory") {
    const store = new MemoryArtifactContentStore() as unknown as ProbeableArtifactContentStore;
    store.probe = async () => ({ ok: true });
    return store;
  }

  if (config.backend === "local") {
    return new LocalObjectArtifactContentStore(config.directory, config.keyPrefix);
  }

  const client = options?.s3Client ?? createS3CompatibleObjectClient({
    endpoint: config.endpoint,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    forcePathStyle: config.forcePathStyle,
    requestTimeoutMs: config.requestTimeoutMs
  });

  return new ObjectArtifactContentStore(
    {
      endpoint: config.endpoint,
      region: config.region,
      bucket: config.bucket,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      forcePathStyle: config.forcePathStyle,
      keyPrefix: config.keyPrefix
    },
    client
  ) as ProbeableArtifactContentStore;
}

function resolveBackend(
  backend: string | undefined,
  objectStoreDir: string | undefined,
  deploymentMode: DeploymentMode
): ObjectStoreBackend {
  if (!backend) {
    if (deploymentMode === "staging" || deploymentMode === "production") {
      throw configRequired("SWITCHYARD_OBJECT_STORE_BACKEND", {
        backend: "memory",
        probe: "write_read_delete",
        keyPrefix: "artifacts"
      });
    }
    return objectStoreDir ? "local" : "memory";
  }
  if (!BACKENDS.has(backend as ObjectStoreBackend)) {
    throw configInvalid("SWITCHYARD_OBJECT_STORE_BACKEND", {
      backend: "memory",
      probe: "write_read_delete",
      keyPrefix: "artifacts"
    });
  }
  if ((deploymentMode === "staging" || deploymentMode === "production") && backend === "memory") {
    throw configInvalid("SWITCHYARD_OBJECT_STORE_BACKEND", {
      backend: "memory",
      probe: "write_read_delete",
      keyPrefix: "artifacts"
    });
  }
  return backend as ObjectStoreBackend;
}

function parseEndpoint(endpoint: string, deploymentMode: DeploymentMode, summary: Record<string, unknown>): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw configInvalid("SWITCHYARD_OBJECT_STORE_ENDPOINT", summary);
  }
  if (!url.protocol || !url.host) {
    throw configInvalid("SWITCHYARD_OBJECT_STORE_ENDPOINT", summary);
  }
  if (url.username || url.password || url.search) {
    throw configInvalid("SWITCHYARD_OBJECT_STORE_ENDPOINT", summary);
  }
  if ((deploymentMode === "staging" || deploymentMode === "production") && url.protocol !== "https:") {
    throw configInvalid("SWITCHYARD_OBJECT_STORE_ENDPOINT", summary);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw configInvalid("SWITCHYARD_OBJECT_STORE_ENDPOINT", summary);
  }
  if (
    (deploymentMode === "local" || deploymentMode === "test") &&
    url.protocol === "http:" &&
    !isLocalHttpHost(url.hostname)
  ) {
    throw configInvalid("SWITCHYARD_OBJECT_STORE_ENDPOINT", summary);
  }
  return url;
}

function isLocalHttpHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function parseKeyPrefix(value: string): string {
  const prefix = value.trim();
  if (prefix.length === 0) {
    throw configInvalid("SWITCHYARD_OBJECT_STORE_KEY_PREFIX", {
      backend: "memory",
      keyPrefix: "[invalid]",
      probe: "write_read_delete"
    });
  }
  if (prefix.startsWith("/") || prefix.endsWith("/") || prefix.includes("\\") || /^[A-Za-z]:/.test(prefix)) {
    throw configInvalid("SWITCHYARD_OBJECT_STORE_KEY_PREFIX", {
      backend: "memory",
      keyPrefix: "[invalid]",
      probe: "write_read_delete"
    });
  }
  const segments = prefix.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw configInvalid("SWITCHYARD_OBJECT_STORE_KEY_PREFIX", {
      backend: "memory",
      keyPrefix: "[invalid]",
      probe: "write_read_delete"
    });
  }
  return prefix;
}

function parseBoolean(
  value: string | undefined,
  defaultValue: boolean,
  variable: string,
  summary: Record<string, unknown>
): boolean {
  if (!value) {
    return defaultValue;
  }
  if (value === "1" || value === "true") {
    return true;
  }
  if (value === "0" || value === "false") {
    return false;
  }
  throw configInvalid(variable, summary);
}

function parsePositiveInt(value: string, variable: string, summary: Record<string, unknown>): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw configInvalid(variable, summary);
  }
  return parsed;
}

function parseProbeMode(
  value: string | undefined,
  deploymentMode: DeploymentMode,
  summary: Record<string, unknown>
): ObjectStoreProbeMode {
  const probe = value ?? "write_read_delete";
  if (probe !== "write_read_delete" && probe !== "disabled") {
    throw configInvalid("SWITCHYARD_OBJECT_STORE_PROBE", summary);
  }
  if ((deploymentMode === "staging" || deploymentMode === "production") && probe === "disabled") {
    throw configInvalid("SWITCHYARD_OBJECT_STORE_PROBE", summary);
  }
  return probe;
}

function required(variable: string, env: NodeJS.ProcessEnv, summary: Record<string, unknown>): string {
  const value = optional(env[variable]);
  if (!value) {
    throw configRequired(variable, summary);
  }
  return value;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function configRequired(variable: string, summary: Record<string, unknown>): ObjectStoreConfigError {
  return new ObjectStoreConfigError(`config_required:${variable}`, variable, {
    objectStore: summary
  });
}

function configInvalid(variable: string, summary: Record<string, unknown>): ObjectStoreConfigError {
  return new ObjectStoreConfigError(`config_invalid:${variable}`, variable, {
    objectStore: summary
  });
}
