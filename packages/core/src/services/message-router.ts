import { createNotImplementedError } from "../errors.js";

export class MessageRouter {
  protected notImplemented(method: string): never {
    throw createNotImplementedError("message-router", method);
  }
}
