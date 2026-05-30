export interface WorkerConfig {
  hostedRuntimeAllowlist: string[];
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const allowlist = (env["SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST"] ?? "fake.deterministic")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return { hostedRuntimeAllowlist: allowlist };
}
