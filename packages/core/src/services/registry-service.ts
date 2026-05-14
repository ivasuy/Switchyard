import { createNotImplementedError } from "../errors.js";

export class RegistryService {
  protected notImplemented(method: string): never {
    throw createNotImplementedError("registry-service", method);
  }
}
