import { URL } from "node:url";
import { providerRuntimeModeSchema } from "@switchyard/contracts";
import type { ProviderRuntimeActivationResult } from "./provider-runtime-policy.js";

export interface ProductionValidationOk {
  ok: true;
}

export interface ProductionValidationFail {
  ok: false;
  code: string;
  variable: string;
}

interface ProductionSecretValidationInput {
  variable: string;
  value?: string | undefined;
  minLength?: number;
}

interface ProductionUrlCredentialValidationInput {
  variable: string;
  value?: string | undefined;
  credential: "password";
}

interface ProductionHttpsUrlValidationInput {
  variable: string;
  value?: string | undefined;
}

const PLACEHOLDER_WORDS = new Set(["switchyard", "password", "secret", "test", "example", "replace-me"]);
const FAKE_RUNTIME_ALLOWLIST = "fake.deterministic";

export interface ProductionHostedRuntimeAllowlistValidationInput {
  allowlist: readonly string[];
  hostedRealRuntimeExecution: "enabled" | "disabled";
  providerActivation?: ProviderRuntimeActivationResult | undefined;
  variable?: string | undefined;
}

export function isPlaceholderSecret(value: string | undefined): boolean {
  const normalized = optional(value);
  if (!normalized) {
    return true;
  }

  const lowered = normalized.toLowerCase();
  for (const word of PLACEHOLDER_WORDS) {
    if (lowered.includes(word)) {
      return true;
    }
  }
  if (lowered.startsWith("replace-with-")) {
    return true;
  }
  return false;
}

export function validateProductionSecret(
  input: ProductionSecretValidationInput
): ProductionValidationOk | ProductionValidationFail {
  const normalized = optional(input.value);
  if (!normalized) {
    return fail(`config_required:${input.variable}`, input.variable);
  }
  if (isPlaceholderSecret(normalized)) {
    return fail(`secret_placeholder:${input.variable}`, input.variable);
  }
  if (input.minLength && normalized.length < input.minLength) {
    return fail(`secret_too_short:${input.variable}`, input.variable);
  }
  return { ok: true };
}

export function validateProductionUrlCredential(
  input: ProductionUrlCredentialValidationInput
): ProductionValidationOk | ProductionValidationFail {
  const normalized = optional(input.value);
  if (!normalized) {
    return fail(`config_required:${input.variable}`, input.variable);
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return fail(`config_invalid:${input.variable}`, input.variable);
  }

  if (!parsed.protocol || !parsed.hostname) {
    return fail(`config_invalid:${input.variable}`, input.variable);
  }

  if (input.credential === "password") {
    const password = optional(parsed.password);
    if (password && isPlaceholderSecret(password)) {
      return fail(`secret_placeholder:${input.variable}`, input.variable);
    }
  }

  return { ok: true };
}

export function validateProductionHostedRuntimeAllowlist(
  input: ProductionHostedRuntimeAllowlistValidationInput
): ProductionValidationOk | ProductionValidationFail {
  const variable = input.variable ?? "SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST";
  if (input.allowlist.length === 0) {
    return fail(`config_required:${variable}`, variable);
  }
  const realModes = input.allowlist.filter((mode) => mode !== FAKE_RUNTIME_ALLOWLIST);
  if (realModes.length === 0) {
    return { ok: true };
  }

  if (input.hostedRealRuntimeExecution !== "enabled") {
    return fail("hosted_real_runtime_disabled", variable);
  }

  if (!input.providerActivation || !input.providerActivation.valid) {
    return fail(input.providerActivation?.reasons[0]?.code ?? "provider_runtime_policy_missing", variable);
  }

  for (const mode of realModes) {
    const parsedMode = providerRuntimeModeSchema.safeParse(mode);
    if (!parsedMode.success || !input.providerActivation.enabledRealModes.includes(parsedMode.data)) {
      return fail("provider_runtime_policy_missing", variable);
    }
  }

  return { ok: true };
}

export function validateProductionFakeOnlyAllowlist(
  allowlist: readonly string[],
  variable = "SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST"
): ProductionValidationOk | ProductionValidationFail {
  return validateProductionHostedRuntimeAllowlist({
    allowlist,
    hostedRealRuntimeExecution: "disabled",
    variable
  });
}

export function validateProductionHttpsUrl(
  input: ProductionHttpsUrlValidationInput
): ProductionValidationOk | ProductionValidationFail {
  const normalized = optional(input.value);
  if (!normalized) {
    return fail(`config_required:${input.variable}`, input.variable);
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return fail(`config_invalid:${input.variable}`, input.variable);
  }

  if (parsed.protocol !== "https:" || !parsed.hostname) {
    return fail(`config_invalid:${input.variable}`, input.variable);
  }

  return { ok: true };
}

export function validateProductionCwdPrefixes(
  prefixes: readonly string[]
): ProductionValidationOk | ProductionValidationFail {
  if (prefixes.length === 0) {
    return fail("config_required:SWITCHYARD_NODE_ALLOW_CWD_PREFIXES", "SWITCHYARD_NODE_ALLOW_CWD_PREFIXES");
  }

  for (const rawPrefix of prefixes) {
    const prefix = rawPrefix.trim();
    if (prefix.length === 0) {
      return fail("config_invalid:SWITCHYARD_NODE_ALLOW_CWD_PREFIXES", "SWITCHYARD_NODE_ALLOW_CWD_PREFIXES");
    }
    if (prefix === "/" || prefix === "." || prefix === "..") {
      return fail("config_invalid:SWITCHYARD_NODE_ALLOW_CWD_PREFIXES", "SWITCHYARD_NODE_ALLOW_CWD_PREFIXES");
    }
    if (prefix.includes("\\")) {
      return fail("config_invalid:SWITCHYARD_NODE_ALLOW_CWD_PREFIXES", "SWITCHYARD_NODE_ALLOW_CWD_PREFIXES");
    }
    if (/^[A-Za-z]:[\\/]*$/.test(prefix)) {
      return fail("config_invalid:SWITCHYARD_NODE_ALLOW_CWD_PREFIXES", "SWITCHYARD_NODE_ALLOW_CWD_PREFIXES");
    }
  }

  return { ok: true };
}

function fail(code: string, variable: string): ProductionValidationFail {
  return { ok: false, code, variable };
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}
