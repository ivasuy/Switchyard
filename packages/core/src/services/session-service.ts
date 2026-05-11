import { createNotImplementedError } from "../errors.js";

export class SessionService {
  protected notImplemented(method: string): never {
    throw createNotImplementedError("session-service", method);
  }
}
