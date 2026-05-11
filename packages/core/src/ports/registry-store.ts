import type { Model, Provider, RuntimeTarget } from "@switchyard/contracts";

export interface RegistryStore {
  createProvider(provider: Provider): Promise<Provider>;
  createRuntime(runtime: RuntimeTarget): Promise<RuntimeTarget>;
  createModel(model: Model): Promise<Model>;
  getProvider(id: string): Promise<Provider | undefined>;
  getRuntime(id: string): Promise<RuntimeTarget | undefined>;
  getModel(id: string): Promise<Model | undefined>;
}
