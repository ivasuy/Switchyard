import type { Model, Provider, RuntimeAvailability, RuntimeMode, RuntimeTarget } from "@switchyard/contracts";

export interface RegistryCursor {
  id: string;
}

export interface ListProvidersFilter {
  limit: number;
  before?: RegistryCursor;
}

export interface ListRuntimesFilter {
  providerIds?: readonly string[];
  adapterType?: readonly string[];
  limit: number;
  before?: RegistryCursor;
}

export interface ListModelsFilter {
  providerIds?: readonly string[];
  limit: number;
  before?: RegistryCursor;
}

export interface ListRuntimeModesFilter {
  providerIds?: readonly string[];
  runtimeIds?: readonly string[];
  adapterType?: readonly string[];
  kind?: readonly string[];
  availability?: readonly string[];
  placement?: readonly string[];
  capability?: readonly string[];
  limit: number;
  before?: RegistryCursor;
}

export interface ListProvidersResult {
  providers: Provider[];
  nextCursor: RegistryCursor | null;
}

export interface ListRuntimesResult {
  runtimes: RuntimeTarget[];
  nextCursor: RegistryCursor | null;
}

export interface ListModelsResult {
  models: Model[];
  nextCursor: RegistryCursor | null;
}

export interface ListRuntimeModesResult {
  runtimeModes: RuntimeMode[];
  nextCursor: RegistryCursor | null;
}

export interface RegistryStore {
  createProvider(provider: Provider): Promise<Provider>;
  createRuntime(runtime: RuntimeTarget): Promise<RuntimeTarget>;
  createModel(model: Model): Promise<Model>;
  getProvider(id: string): Promise<Provider | undefined>;
  getRuntime(id: string): Promise<RuntimeTarget | undefined>;
  getModel(id: string): Promise<Model | undefined>;
  listProviders(filter: ListProvidersFilter): Promise<ListProvidersResult>;
  listRuntimes(filter: ListRuntimesFilter): Promise<ListRuntimesResult>;
  listModels(filter: ListModelsFilter): Promise<ListModelsResult>;
  upsertRuntimeMode(mode: RuntimeMode): Promise<RuntimeMode>;
  getRuntimeMode(idOrSlug: string): Promise<RuntimeMode | undefined>;
  listRuntimeModes(filter: ListRuntimeModesFilter): Promise<ListRuntimeModesResult>;
  updateRuntimeModeAvailability(idOrSlug: string, availability: RuntimeAvailability): Promise<RuntimeMode | undefined>;
}
