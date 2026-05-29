import type { RuntimeAvailability, RuntimeMode } from "@switchyard/contracts";
import type { RegistryStore } from "../ports/registry-store.js";
import type { RuntimeAdapterManifest } from "../ports/runtime-adapter.js";

export interface RuntimeCapabilityServiceDependencies {
  registry: RegistryStore;
  clock?: () => string;
}

export class RuntimeCapabilityService {
  private readonly registry: RegistryStore;
  private readonly clock: () => string;

  constructor(deps: RuntimeCapabilityServiceDependencies) {
    this.registry = deps.registry;
    this.clock = deps.clock ?? (() => new Date().toISOString());
  }

  async upsertManifest(manifest: RuntimeAdapterManifest, availability?: RuntimeAvailability): Promise<RuntimeMode> {
    const now = this.clock();
    const availabilitySnapshot = availability ?? unknownAvailability(now);
    const existing = await this.registry.getRuntimeMode(manifest.runtimeModeId);

    const mode: RuntimeMode = {
      id: manifest.runtimeModeId,
      slug: manifest.runtimeModeSlug,
      name: manifest.name,
      providerId: manifest.providerId,
      runtimeId: manifest.runtimeId,
      adapterId: manifest.adapterId,
      adapterType: manifest.adapterType,
      kind: manifest.kind,
      status: availabilitySnapshot.state,
      capabilities: manifest.capabilities,
      limitations: manifest.limitations,
      placement: manifest.placement,
      availability: availabilitySnapshot,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    if (manifest.docsPath !== undefined) {
      mode.docsPath = manifest.docsPath;
    }
    return this.registry.upsertRuntimeMode(mode);
  }

  async seedManifests(
    manifests: RuntimeAdapterManifest[],
    availabilityBySlug: Record<string, RuntimeAvailability> = {}
  ): Promise<RuntimeMode[]> {
    const seeded: RuntimeMode[] = [];
    for (const manifest of manifests) {
      seeded.push(await this.upsertManifest(manifest, availabilityBySlug[manifest.runtimeModeSlug]));
    }
    return seeded;
  }
}

function unknownAvailability(now: string): RuntimeAvailability {
  return {
    state: "unknown",
    canRun: false,
    installed: false,
    auth: "unknown",
    version: null,
    checkedAt: now,
    reasonCode: null,
    message: null
  };
}
