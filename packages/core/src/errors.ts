import type { SwitchyardError } from "@switchyard/contracts";

export class SwitchyardDomainError extends Error {
  readonly code: SwitchyardError["code"];

  constructor(error: SwitchyardError) {
    super(error.message);
    this.name = "SwitchyardDomainError";
    this.code = error.code;
  }
}

export function createNotImplementedError(service: string, method: string): SwitchyardDomainError {
  return new SwitchyardDomainError({
    code: "adapter_protocol_failed",
    message: `${service}.${method} is not implemented yet`
  });
}
