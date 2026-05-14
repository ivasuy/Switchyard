import { createNotImplementedError } from "../errors.js";

export class ApprovalService {
  protected notImplemented(method: string): never {
    throw createNotImplementedError("approval-service", method);
  }
}
