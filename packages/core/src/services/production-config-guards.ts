import { URL } from "node:url";

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

export function validateProductionFakeOnlyAllowlist(
  allowlist: readonly string[],
  variable = "SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST"
): ProductionValidationOk | ProductionValidationFail {
  if (allowlist.length === 0) {
    return fail(`config_required:${variable}`, variable);
  }
  if (allowlist.length === 1 && allowlist[0] === FAKE_RUNTIME_ALLOWLIST) {
    return { ok: true };
  }
  return fail("hosted_real_runtime_production_forbidden", variable);
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
