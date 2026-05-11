import { createNotImplementedError } from "../errors.js";

export class MemoryService {
  protected notImplemented(method: string): never {
    throw createNotImplementedError("memory-service", method);
  }
}
