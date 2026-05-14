import { createNotImplementedError } from "../errors.js";

export class DebateService {
  protected notImplemented(method: string): never {
    throw createNotImplementedError("debate-service", method);
  }
}
