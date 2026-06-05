import { runtimeModeSlugSchema } from "@switchyard/contracts";
import type { RegistryStore } from "../ports/registry-store.js";
import type { AdapterType } from "@switchyard/contracts";

export interface RuntimeModeValidationDetail {
  path: string;
  issue: string;
}

export class RuntimeModeValidationError extends Error {
  readonly code = "invalid_input";
  readonly details: RuntimeModeValidationDetail[];

  constructor(message: string, details: RuntimeModeValidationDetail[]) {
    super(message);
    this.details = details;
  }
}

export class RegistryService {
  constructor(private readonly deps: { registry: RegistryStore }) {}

  async inferAndValidateRuntimeMode(input: {
    runtime: string;
    provider: string;
    adapterType: AdapterType;
    runtimeMode?: string;
  }): Promise<string | undefined> {
    if (!input.runtimeMode) {
      return inferRuntimeMode(input);
    }

    const runtimeMode = parseRuntimeModeSlug(input.runtimeMode);
    const mode = await this.deps.registry.getRuntimeMode(runtimeMode);
    if (!mode) {
      throw new RuntimeModeValidationError("runtimeMode does not exist", [
        { path: "runtimeMode", issue: "must reference a known runtime mode slug" }
      ]);
    }

    const expectedRuntimeId = asRuntimeId(input.runtime);
    const expectedProviderId = asProviderId(input.provider);
    const mismatched =
      mode.runtimeId !== expectedRuntimeId ||
      mode.providerId !== expectedProviderId ||
      mode.adapterType !== input.adapterType;
    if (mismatched) {
      throw new RuntimeModeValidationError("runtimeMode does not match runtime/provider/adapterType", [
        { path: "runtimeMode", issue: "must match runtime, provider, and adapterType" }
      ]);
    }
    return mode.slug;
  }
}

function parseRuntimeModeSlug(value: string): string {
  try {
    return runtimeModeSlugSchema.parse(value);
  } catch (error) {
    if (value.startsWith("runtime_mode_")) {
      throw new RuntimeModeValidationError("runtimeMode must be a runtime mode slug, not an internal id", [
        { path: "runtimeMode", issue: "must be a runtime mode slug such as codex.exec_json" }
      ]);
    }
    throw new RuntimeModeValidationError("runtimeMode is invalid", [
      { path: "runtimeMode", issue: "must be a dot-separated lowercase runtime mode slug" }
    ]);
  }
}

function inferRuntimeMode(input: { runtime: string; adapterType: AdapterType }): string | undefined {
  if (input.runtime === "fake") {
    return "fake.deterministic";
  }
  if (input.runtime === "codex" && input.adapterType === "process") {
    return "codex.exec_json";
  }
  if (input.runtime === "generic_http" && input.adapterType === "http") {
    return "generic_http.async_rest";
  }
  if (input.runtime === "agentfield" && input.adapterType === "http") {
    return "agentfield.async_rest";
  }
  if (input.runtime === "opencode" && input.adapterType === "acpx") {
    return "opencode.acp";
  }
  if (input.runtime === "claude_code" && input.adapterType === "native") {
    return "claude_code.sdk";
  }
  return undefined;
}

function asRuntimeId(runtime: string): string {
  return runtime.startsWith("runtime_") ? runtime : `runtime_${runtime}`;
}

function asProviderId(provider: string): string {
  return provider.startsWith("provider_") ? provider : `provider_${provider}`;
}
