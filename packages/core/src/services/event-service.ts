import { createNotImplementedError } from "../errors.js";

export class EventService {
  protected notImplemented(method: string): never {
    throw createNotImplementedError("event-service", method);
  }
}
