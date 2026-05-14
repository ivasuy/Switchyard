import { createNotImplementedError } from "../errors.js";

export class PlacementService {
  protected notImplemented(method: string): never {
    throw createNotImplementedError("placement-service", method);
  }
}
