import type { SwitchyardError } from "@switchyard/contracts";

export class SwitchyardDomainError extends Error {
  readonly code: SwitchyardError["code"];

  constructor(error: SwitchyardError) {
    super(error.message);
    this.name = "SwitchyardDomainError";
    this.code = error.code;
  }
}

export class AdapterProtocolError extends Error {
  readonly code = "adapter_protocol_failed" as const;
  readonly reasonCode: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    message: string,
    options: {
      reasonCode?: string;
      details?: Record<string, unknown>;
    } = {}
  ) {
    super(message);
    this.name = "AdapterProtocolError";
    this.reasonCode = options.reasonCode;
    this.details = options.details;
  }
}

export function createNotImplementedError(service: string, method: string): SwitchyardDomainError {
  return new SwitchyardDomainError({
    code: "adapter_protocol_failed",
    message: `${service}.${method} is not implemented yet`
  });
}
