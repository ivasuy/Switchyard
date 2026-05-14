import { createNotImplementedError } from "../errors.js";

export class EvidenceService {
  protected notImplemented(method: string): never {
    throw createNotImplementedError("evidence-service", method);
  }
}
