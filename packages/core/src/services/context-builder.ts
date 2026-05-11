import { createNotImplementedError } from "../errors.js";

export class ContextBuilder {
  protected notImplemented(method: string): never {
    throw createNotImplementedError("context-builder", method);
  }
}
