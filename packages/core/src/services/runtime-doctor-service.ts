import type {
  DoctorSummaryResponse,
  RuntimeAvailability,
  RuntimeDoctorCheck,
  RuntimeMode
} from "@switchyard/contracts";
import type { RegistryStore } from "../ports/registry-store.js";
import type { RuntimeAdapter, RuntimeAdapterCheck } from "../ports/runtime-adapter.js";
import type { RuntimeLogger } from "../ports/runtime-logger.js";
import { TimeoutError, withTimeout } from "./runtime-timeout.js";

export interface RuntimeDoctorServiceDependencies {
  registry: RegistryStore;
  adapters: Map<string, RuntimeAdapter>;
  clock?: () => string;
  logger?: RuntimeLogger | undefined;
  checkTimeoutMs?: number;
  maxDiagnosticBytes?: number;
}

export class RuntimeDoctorService {
  private readonly registry: RegistryStore;
  private readonly adapters: Map<string, RuntimeAdapter>;
  private readonly clock: () => string;
  private readonly logger: RuntimeLogger | undefined;
  private readonly checkTimeoutMs: number;
  private readonly maxDiagnosticBytes: number;

  constructor(deps: RuntimeDoctorServiceDependencies) {
    this.registry = deps.registry;
    this.adapters = deps.adapters;
    this.clock = deps.clock ?? (() => new Date().toISOString());
    this.logger = deps.logger;
    this.checkTimeoutMs = deps.checkTimeoutMs ?? 5000;
    this.maxDiagnosticBytes = deps.maxDiagnosticBytes ?? 4096;
  }

  async checkRuntimeMode(idOrSlug: string): Promise<RuntimeDoctorCheck> {
    const mode = await this.registry.getRuntimeMode(idOrSlug);
    if (!mode) {
      throw new Error(`Runtime mode not found: ${idOrSlug}`);
    }

    const adapter = this.adapters.get(mode.adapterId);
    if (!adapter) {
      const unsupported = this.buildCheck(mode, {
        state: "unsupported",
        canRun: false,
        installed: false,
        auth: "unknown",
        version: null,
        checkedAt: this.clock(),
        reasonCode: "adapter_not_registered",
        message: "Runtime adapter is not registered."
      }, [
        { code: "adapter_not_registered", severity: "error", message: "Runtime adapter is not registered for this runtime mode." }
      ]);
      await this.registry.updateRuntimeModeAvailability(mode.id, unsupportedToAvailability(unsupported));
      return unsupported;
    }

    const startedAt = this.clock();
    const checked = await this.runBoundedCheck(adapter, mode, startedAt);
    await this.registry.updateRuntimeModeAvailability(mode.id, unsupportedToAvailability(checked));
    this.logger?.info("runtime_mode.check", {
      runtimeMode: mode.slug,
      state: checked.state,
      canRun: checked.canRun,
      reasonCode: checked.reasonCode
    });
    return checked;
  }

  async summarize(): Promise<DoctorSummaryResponse> {
    const listed = await this.registry.listRuntimeModes({ limit: 1000 });
    const runtimeModes = listed.runtimeModes.map((mode) => ({
      runtimeModeId: mode.id,
      runtimeMode: mode.slug,
      state: mode.availability.state,
      canRun: mode.availability.canRun,
      checkedAt: mode.availability.checkedAt
    }));
    const summary: DoctorSummaryResponse["summary"] = {
      available: 0,
      installed: 0,
      partial: 0,
      unavailable: 0,
      unsupported: 0,
      unknown: 0
    };
    for (const mode of runtimeModes) {
      summary[mode.state] += 1;
    }
    return { runtimeModes, summary };
  }

  private async runBoundedCheck(adapter: RuntimeAdapter, mode: RuntimeMode, checkedAt: string): Promise<RuntimeDoctorCheck> {
    let checkResult: RuntimeAdapterCheck;
    try {
      checkResult = await withTimeout(
        adapter.check({
          runtimeMode: mode.slug,
          timeoutMs: this.checkTimeoutMs,
          maxDiagnosticBytes: this.maxDiagnosticBytes
        }),
        this.checkTimeoutMs,
        "runtime check"
      );
    } catch (error) {
      if (error instanceof TimeoutError) {
        return this.buildCheck(mode, {
          state: "unknown",
          canRun: false,
          installed: false,
          auth: "unknown",
          version: null,
          checkedAt,
          reasonCode: "check_timeout",
          message: "Runtime check timed out."
        }, [{ code: "check_timeout", severity: "error", message: "Runtime check exceeded configured timeout." }]);
      }
      return this.buildCheck(mode, {
        state: "unknown",
        canRun: false,
        installed: false,
        auth: "unknown",
        version: null,
        checkedAt,
        reasonCode: "check_failed",
        message: sanitizeMessage(error instanceof Error ? error.message : String(error), this.maxDiagnosticBytes)
      }, [{ code: "check_failed", severity: "error", message: "Runtime check failed unexpectedly." }]);
    }

    const details = (checkResult.details ?? {}) as Record<string, unknown>;
    const outputBytes = typeof details["outputBytes"] === "number" ? details["outputBytes"] : undefined;
    if (outputBytes !== undefined && outputBytes > this.maxDiagnosticBytes) {
      return this.buildCheck(mode, {
        state: "unknown",
        canRun: false,
        installed: false,
        auth: "unknown",
        version: null,
        checkedAt,
        reasonCode: "check_output_too_large",
        message: "Runtime check output exceeded configured bounds."
      }, [{ code: "check_output_too_large", severity: "error", message: "Runtime check output exceeded configured bounds." }]);
    }

    if (mode.slug === "fake.deterministic") {
      return this.buildCheck(mode, {
        state: "available",
        canRun: true,
        installed: true,
        auth: "not_required",
        version: null,
        checkedAt,
        reasonCode: null,
        message: null
      }, []);
    }

    if (isHttpHealthMode(mode, details)) {
      return mapHttpHealthCheck(mode, checkResult, details, checkedAt, this.maxDiagnosticBytes);
    }

    const version = typeof details["version"] === "string" && details["version"].length > 0
      ? details["version"]
      : null;
    const models = Array.isArray(details["models"]) ? details["models"] : [];
    const optionalChecks = isRecord(details["optionalChecks"]) ? details["optionalChecks"] : {};

    if (!checkResult.ok || !version) {
      return this.buildCheck(mode, {
        state: "unavailable",
        canRun: false,
        installed: false,
        auth: "unknown",
        version,
        checkedAt,
        reasonCode: "binary_unavailable",
        message: sanitizeMessage(checkResult.message ?? "Required runtime binary is unavailable.", this.maxDiagnosticBytes)
      }, [{ code: "binary_unavailable", severity: "error", message: "Runtime binary is unavailable on PATH." }]);
    }

    if (models.length === 0) {
      return this.buildCheck(mode, {
        state: "unavailable",
        canRun: false,
        installed: true,
        auth: "configured",
        version,
        checkedAt,
        reasonCode: "model_catalog_unavailable",
        message: "No usable model catalog entries were returned."
      }, [{ code: "model_catalog_unavailable", severity: "error", message: "Runtime model catalog is unavailable." }]);
    }

    const optionalFailures = mode.slug === "codex.exec_json"
      ? optionalFailureDiagnostics(optionalChecks, this.maxDiagnosticBytes)
      : [];
    if (optionalFailures.length > 0) {
      return this.buildCheck(mode, {
        state: "partial",
        canRun: true,
        installed: true,
        auth: "configured",
        version,
        checkedAt,
        reasonCode: "optional_check_failed",
        message: "Optional runtime checks failed."
      }, optionalFailures);
    }

    return this.buildCheck(mode, {
      state: "available",
      canRun: true,
      installed: true,
      auth: "configured",
      version,
      checkedAt,
      reasonCode: null,
      message: null
    }, [
      { code: "binary_version_ok", severity: "info", message: "Runtime binary version check succeeded." },
      { code: "model_catalog_ok", severity: "info", message: "Runtime model catalog check succeeded." }
    ]);
  }

  private buildCheck(
    mode: RuntimeMode,
    availability: RuntimeAvailability,
    diagnostics: RuntimeDoctorCheck["diagnostics"]
  ): RuntimeDoctorCheck {
    return {
      runtimeModeId: mode.id,
      runtimeMode: mode.slug,
      providerId: mode.providerId,
      runtimeId: mode.runtimeId,
      state: availability.state,
      canRun: availability.canRun,
      installed: availability.installed,
      auth: availability.auth,
      version: availability.version,
      checkedAt: availability.checkedAt,
      reasonCode: availability.reasonCode,
      message: availability.message,
      capabilities: mode.capabilities,
      limitations: mode.limitations,
      diagnostics
    };
  }
}

function unsupportedToAvailability(check: RuntimeDoctorCheck): RuntimeAvailability {
  return {
    state: check.state,
    canRun: check.canRun,
    installed: check.installed,
    auth: check.auth,
    version: check.version,
    checkedAt: check.checkedAt,
    reasonCode: check.reasonCode,
    message: check.message
  };
}

function optionalFailureDiagnostics(
  optionalChecks: Record<string, unknown>,
  maxDiagnosticBytes: number
): RuntimeDoctorCheck["diagnostics"] {
  const diagnostics: RuntimeDoctorCheck["diagnostics"] = [];
  for (const [code, result] of Object.entries(optionalChecks)) {
    if (!isRecord(result)) {
      continue;
    }
    if (result["ok"] === false) {
      const rawMessage = typeof result["message"] === "string" ? result["message"] : "Optional runtime check failed.";
      diagnostics.push({
        code,
        severity: "warning",
        message: sanitizeMessage(rawMessage, maxDiagnosticBytes)
      });
    }
  }
  return diagnostics;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sanitizeMessage(message: string, maxDiagnosticBytes: number): string {
  const budget = Math.max(16, maxDiagnosticBytes);
  const redacted = redactSecrets(message);
  const bytes = Buffer.byteLength(redacted, "utf8");
  if (bytes <= budget) {
    return redacted;
  }
  const truncated = redacted.slice(0, Math.max(1, budget - 3));
  return `${truncated}...`;
}

function redactSecrets(input: string): string {
  return input
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/(authorization\s*[:=]\s*)([^\s,;]+)/gi, "$1[REDACTED]")
    .replace(/([A-Za-z0-9_-]*token[A-Za-z0-9_-]*\s*[:=]\s*)([^\s,;]+)/gi, "$1[REDACTED]");
}

function isHttpHealthMode(mode: RuntimeMode, details: Record<string, unknown>): boolean {
  if (mode.slug === "generic_http.async_rest") {
    return true;
  }
  return isRecord(details["availability"]);
}

function mapHttpHealthCheck(
  mode: RuntimeMode,
  checkResult: RuntimeAdapterCheck,
  details: Record<string, unknown>,
  checkedAt: string,
  maxDiagnosticBytes: number
): RuntimeDoctorCheck {
  const availability = isRecord(details["availability"]) ? details["availability"] : undefined;
  const diagnostics = sanitizeDiagnostics(details["diagnostics"], maxDiagnosticBytes);

  if (!availability) {
    return {
      runtimeModeId: mode.id,
      runtimeMode: mode.slug,
      providerId: mode.providerId,
      runtimeId: mode.runtimeId,
      state: "unknown",
      canRun: false,
      installed: false,
      auth: "unknown",
      version: null,
      checkedAt,
      reasonCode: "generic_http_health_invalid",
      message: sanitizeMessage(checkResult.message ?? "Invalid Generic HTTP health response.", maxDiagnosticBytes),
      capabilities: mode.capabilities,
      limitations: mode.limitations,
      diagnostics: diagnostics.length > 0
        ? diagnostics
        : [{ code: "generic_http_health_invalid", severity: "error", message: "Invalid Generic HTTP health response." }]
    };
  }

  const state = parseAvailabilityState(availability["state"]);
  const auth = parseAvailabilityAuth(availability["auth"]);
  const reasonCode = typeof availability["reasonCode"] === "string" ? availability["reasonCode"] : null;
  const message = typeof availability["message"] === "string"
    ? sanitizeMessage(availability["message"], maxDiagnosticBytes)
    : null;
  const version = typeof availability["version"] === "string" && availability["version"].length > 0
    ? sanitizeMessage(availability["version"], maxDiagnosticBytes)
    : null;

  return {
    runtimeModeId: mode.id,
    runtimeMode: mode.slug,
    providerId: mode.providerId,
    runtimeId: mode.runtimeId,
    state,
    canRun: availability["canRun"] === true,
    installed: availability["installed"] === true,
    auth,
    version,
    checkedAt,
    reasonCode,
    message,
    capabilities: mode.capabilities,
    limitations: mode.limitations,
    diagnostics
  };
}

function sanitizeDiagnostics(
  diagnostics: unknown,
  maxDiagnosticBytes: number
): RuntimeDoctorCheck["diagnostics"] {
  if (!Array.isArray(diagnostics)) {
    return [];
  }
  const output: RuntimeDoctorCheck["diagnostics"] = [];
  for (const entry of diagnostics) {
    if (!isRecord(entry)) {
      continue;
    }
    const code = typeof entry["code"] === "string" ? entry["code"] : "check_diagnostic";
    const severity = entry["severity"] === "warning" || entry["severity"] === "error" ? entry["severity"] : "info";
    const message = sanitizeMessage(
      typeof entry["message"] === "string" ? entry["message"] : "Runtime diagnostic.",
      maxDiagnosticBytes
    );
    output.push({ code, severity, message });
  }
  return output;
}

function parseAvailabilityState(value: unknown): RuntimeAvailability["state"] {
  if (
    value === "available" ||
    value === "installed" ||
    value === "unavailable" ||
    value === "unsupported" ||
    value === "partial" ||
    value === "unknown"
  ) {
    return value;
  }
  return "unknown";
}

function parseAvailabilityAuth(value: unknown): RuntimeAvailability["auth"] {
  if (value === "not_required" || value === "configured" || value === "missing" || value === "unknown") {
    return value;
  }
  return "unknown";
}
