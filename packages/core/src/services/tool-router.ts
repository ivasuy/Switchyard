import { createNotImplementedError } from "../errors.js";

export class ToolRouter {
  protected notImplemented(method: string): never {
    throw createNotImplementedError("tool-router", method);
  }
}
