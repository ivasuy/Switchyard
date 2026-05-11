import { createNotImplementedError } from "../errors.js";

class ServiceShell {
  constructor(private readonly serviceName: string) {}

  protected notImplemented(method: string): never {
    throw createNotImplementedError(this.serviceName, method);
  }
}

export class ApprovalService extends ServiceShell {
  constructor() {
    super("approval-service");
  }
}

export class ArtifactService extends ServiceShell {
  constructor() {
    super("artifact-service");
  }
}

export class ContextBuilder extends ServiceShell {
  constructor() {
    super("context-builder");
  }
}

export class DebateService extends ServiceShell {
  constructor() {
    super("debate-service");
  }
}

export class EventService extends ServiceShell {
  constructor() {
    super("event-service");
  }
}

export class EvidenceService extends ServiceShell {
  constructor() {
    super("evidence-service");
  }
}

export class MemoryService extends ServiceShell {
  constructor() {
    super("memory-service");
  }
}

export class MessageRouter extends ServiceShell {
  constructor() {
    super("message-router");
  }
}

export class PlacementService extends ServiceShell {
  constructor() {
    super("placement-service");
  }
}

export class RegistryService extends ServiceShell {
  constructor() {
    super("registry-service");
  }
}

export class SessionService extends ServiceShell {
  constructor() {
    super("session-service");
  }
}

export class ToolRouter extends ServiceShell {
  constructor() {
    super("tool-router");
  }
}
