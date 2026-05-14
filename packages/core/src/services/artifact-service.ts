import { createNotImplementedError } from "../errors.js";

export class ArtifactService {
  protected notImplemented(method: string): never {
    throw createNotImplementedError("artifact-service", method);
  }
}
