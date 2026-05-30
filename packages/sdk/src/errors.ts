import type { HttpErrorCode, HttpErrorDetail } from "@switchyard/contracts";

export class SwitchyardHttpError extends Error {
  readonly status: number;
  readonly code: HttpErrorCode;
  readonly details: HttpErrorDetail[] | undefined;
  readonly requestId: string | undefined;

  constructor(input: {
    status: number;
    code: HttpErrorCode;
    message: string;
    details?: HttpErrorDetail[] | undefined;
    requestId?: string | undefined;
  }) {
    super(input.message);
    this.name = "SwitchyardHttpError";
    this.status = input.status;
    this.code = input.code;
    this.details = input.details;
    this.requestId = input.requestId;
  }
}

export class SwitchyardNetworkError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "SwitchyardNetworkError";
  }
}

export class SwitchyardDecodeError extends Error {
  readonly status: number | undefined;
  readonly requestId: string | undefined;

  constructor(message: string, options: { status?: number | undefined; requestId?: string | undefined; cause?: unknown } = {}) {
    super(message);
    this.name = "SwitchyardDecodeError";
    this.status = options.status;
    this.requestId = options.requestId;
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export class SwitchyardTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwitchyardTimeoutError";
  }
}

export class SwitchyardValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwitchyardValidationError";
  }
}

export class SwitchyardStreamError extends Error {
  readonly requestId: string | undefined;

  constructor(message: string, options: { requestId?: string | undefined; cause?: unknown } = {}) {
    super(message);
    this.name = "SwitchyardStreamError";
    this.requestId = options.requestId;
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}
