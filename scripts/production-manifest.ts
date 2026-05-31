import { readFile } from "node:fs/promises";

export interface ProductionManifestService {
  deploymentMode?: string;
  command?: string[] | string;
  requiredEnv?: string[];
  healthChecks?: string[];
  readinessChecks?: string[];
  readinessGate?: {
    command?: string[] | string;
  };
  privateDependencies?: string[];
  policy?: {
    runtimeAllowlist?: string[];
    hostedRealRuntimeExecution?: string;
    realTools?: string;
    objectStoreProbe?: string;
  };
  runtimeAllowlist?: string[];
  hostedRealRuntimeExecution?: string;
  objectStoreProbe?: string;
}

export interface ProductionManifest {
  version?: string;
  services: {
    server: ProductionManifestService;
    worker: ProductionManifestService;
    node?: ProductionManifestService;
    [name: string]: ProductionManifestService | undefined;
  };
  requiredEnv?: string[];
  forbiddenSurfaces?: string[];
}

export type ProductionManifestErrorCode =
  | "manifest_missing"
  | "manifest_invalid"
  | "manifest_forbidden_command"
  | "manifest_forbidden_surface"
  | "manifest_env_missing";

export interface ProductionManifestError {
  code: ProductionManifestErrorCode;
  service?: string;
}

export type ProductionManifestValidationResult =
  | { ok: true; manifest: ProductionManifest }
  | { ok: false; errors: ProductionManifestError[] };

const FORBIDDEN_SERVICE_NAMES = new Set([
  "dashboard",
  "tui",
  "payment",
  "oauth",
  "browser",
  "exec",
  "sandbox",
  "pty",
  "terminal",
  "hosted-real-runtime",
  "real-tool"
]);

const REQUIRED_TOP_LEVEL_ENV = [
  "SWITCHYARD_DEPLOYMENT_MODE",
  "SWITCHYARD_SERVER_AUTH_MODE",
  "SWITCHYARD_CONTROL_PLANE_STORE",
  "SWITCHYARD_POSTGRES_URL",
  "SWITCHYARD_REDIS_URL",
  "SWITCHYARD_OBJECT_STORE_BACKEND",
  "SWITCHYARD_OBJECT_STORE_PROBE",
  "SWITCHYARD_NODE_SHARED_TOKEN",
  "SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST",
  "SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION"
] as const;

const REQUIRED_SERVER_ENV = [
  "SWITCHYARD_DEPLOYMENT_MODE",
  "SWITCHYARD_SERVER_AUTH_MODE",
  "SWITCHYARD_CONTROL_PLANE_STORE",
  "SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST",
  "SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION"
] as const;

const REQUIRED_WORKER_ENV = [
  "SWITCHYARD_DEPLOYMENT_MODE",
  "SWITCHYARD_OBJECT_STORE_PROBE",
  "SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST",
  "SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION"
] as const;

export async function validateProductionManifest(path: string): Promise<ProductionManifestValidationResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return {
        ok: false,
        errors: [{ code: "manifest_missing" }]
      };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      errors: [{ code: "manifest_invalid" }]
    };
  }

  if (!isRecord(parsed) || !isRecord(parsed.services) || !isRecord(parsed.services.server) || !isRecord(parsed.services.worker)) {
    return {
      ok: false,
      errors: [{ code: "manifest_invalid" }]
    };
  }

  const manifest = parsed as ProductionManifest;
  const errors: ProductionManifestError[] = [];

  validateServiceShape("server", manifest.services.server, errors);
  validateServiceShape("worker", manifest.services.worker, errors);
  if (manifest.services.node) {
    validateServiceShape("node", manifest.services.node, errors);
  }

  validateServiceCommands(manifest.services, errors);
  validateForbiddenSurfaces(manifest.services, errors);
  validateRequiredEnv(manifest, errors);
  validateReadinessChecks(manifest.services.server, manifest.services.worker, errors);
  validateRuntimePosture(manifest.services, errors);
  validateObjectStoreProbePosture(manifest.services, errors);

  if (errors.length > 0) {
    return {
      ok: false,
      errors
    };
  }

  return {
    ok: true,
    manifest
  };
}

function validateServiceShape(name: string, service: ProductionManifestService, errors: ProductionManifestError[]): void {
  if (service.deploymentMode !== "production") {
    errors.push({ code: "manifest_invalid", service: name });
  }
}

function validateServiceCommands(
  services: ProductionManifest["services"],
  errors: ProductionManifestError[]
): void {
  for (const [name, service] of Object.entries(services)) {
    if (!service) {
      continue;
    }
    const command = Array.isArray(service.command)
      ? service.command.join(" ")
      : typeof service.command === "string"
        ? service.command
        : "";

    if (command.length === 0) {
      errors.push({ code: "manifest_invalid", service: name });
      continue;
    }

    if (/\bdev\b/i.test(command) || /(pnpm|npm|yarn)\s+install/i.test(command) || /corepack\s+enable/i.test(command)) {
      errors.push({ code: "manifest_forbidden_command", service: name });
    }
  }
}

function validateForbiddenSurfaces(
  services: ProductionManifest["services"],
  errors: ProductionManifestError[]
): void {
  for (const name of Object.keys(services)) {
    if (FORBIDDEN_SERVICE_NAMES.has(name)) {
      errors.push({ code: "manifest_forbidden_surface", service: name });
    }
  }
}

function validateRequiredEnv(manifest: ProductionManifest, errors: ProductionManifestError[]): void {
  const topLevelEnv = new Set(manifest.requiredEnv ?? []);
  for (const requiredKey of REQUIRED_TOP_LEVEL_ENV) {
    if (!topLevelEnv.has(requiredKey)) {
      errors.push({ code: "manifest_env_missing" });
      break;
    }
  }

  const serverEnv = new Set(manifest.services.server.requiredEnv ?? []);
  for (const requiredKey of REQUIRED_SERVER_ENV) {
    if (!serverEnv.has(requiredKey)) {
      errors.push({ code: "manifest_env_missing", service: "server" });
      break;
    }
  }

  const workerEnv = new Set(manifest.services.worker.requiredEnv ?? []);
  for (const requiredKey of REQUIRED_WORKER_ENV) {
    if (!workerEnv.has(requiredKey)) {
      errors.push({ code: "manifest_env_missing", service: "worker" });
      break;
    }
  }
}

function validateReadinessChecks(
  server: ProductionManifestService,
  worker: ProductionManifestService,
  errors: ProductionManifestError[]
): void {
  const healthChecks = new Set(server.healthChecks ?? []);
  if (!healthChecks.has("GET /health") || !healthChecks.has("GET /ready")) {
    errors.push({ code: "manifest_invalid", service: "server" });
  }

  const readinessChecks = worker.readinessChecks ?? [];
  const legacyFreeText = readinessChecks.some((entry) => entry.trim().length > 0);
  const readinessGateCommand = normalizeCommand(worker.readinessGate?.command);
  if (legacyFreeText || readinessGateCommand !== "node apps/worker/dist/ready.js") {
    errors.push({ code: "manifest_invalid", service: "worker" });
  }
}

function validateRuntimePosture(
  services: ProductionManifest["services"],
  errors: ProductionManifestError[]
): void {
  for (const [name, service] of Object.entries(services)) {
    if (!service) {
      continue;
    }
    const allowlist = service.policy?.runtimeAllowlist ?? service.runtimeAllowlist;
    const hostedRealRuntimeExecution = service.policy?.hostedRealRuntimeExecution ?? service.hostedRealRuntimeExecution;
    const fakeOnly = allowlist?.length === 1 && allowlist[0] === "fake.deterministic";
    if (!fakeOnly || hostedRealRuntimeExecution !== "disabled") {
      errors.push({ code: "manifest_forbidden_surface", service: name });
    }
  }
}

function validateObjectStoreProbePosture(
  services: ProductionManifest["services"],
  errors: ProductionManifestError[]
): void {
  for (const [name, service] of Object.entries(services)) {
    if (!service) {
      continue;
    }
    if (name !== "server" && name !== "worker") {
      continue;
    }
    const probe = service.policy?.objectStoreProbe ?? service.objectStoreProbe;
    if (probe !== "write_read_delete") {
      errors.push({ code: "manifest_invalid", service: name });
    }
  }
}

function normalizeCommand(command: string[] | string | undefined): string {
  if (Array.isArray(command)) {
    return command.join(" ").trim();
  }
  return typeof command === "string" ? command.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
