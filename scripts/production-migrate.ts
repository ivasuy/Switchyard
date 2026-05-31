import { pathToFileURL } from "node:url";
import { redactSecrets } from "../packages/core/src/index.js";
import { migratePostgresSchema, openPostgresDatabase, type PostgresDatabaseHandle } from "../packages/storage/src/index.js";
import { parseProductionEnvFile } from "./production-env.js";

export interface ProductionMigrationResult {
  ok: boolean;
  code: string;
  version?: number;
  checks: Array<{ name: string; status: "pass" | "fail"; code: string; diagnostics?: Record<string, unknown> }>;
  summary: {
    checkedAt: string;
  };
}

export interface MigrationDeps {
  parseEnvFile?: typeof parseProductionEnvFile;
  openPostgresDatabase?: typeof openPostgresDatabase;
  migratePostgresSchema?: (handle: PostgresDatabaseHandle) => Promise<{ ok: true; version: number }>;
  now?: () => Date;
}

export async function runProductionMigration(options: { envFile?: string; deps?: MigrationDeps } = {}): Promise<ProductionMigrationResult> {
  const deps = options.deps ?? {};
  const now = deps.now ?? (() => new Date());
  const checks: ProductionMigrationResult["checks"] = [];

  const envResult = options.envFile
    ? await (deps.parseEnvFile ?? parseProductionEnvFile)(options.envFile)
    : ({ ok: true, values: {} } as const);

  if (!envResult.ok) {
    for (const error of envResult.errors) {
      checks.push({
        name: "envFile",
        status: "fail",
        code: error.code,
        ...(error.line ? { diagnostics: { line: error.line, ...(error.key ? { key: error.key } : {}) } } : {})
      });
    }
    return {
      ok: false,
      code: envResult.errors[0]?.code ?? "env_file_invalid_line",
      checks,
      summary: {
        checkedAt: now().toISOString()
      }
    };
  }

  checks.push({ name: "envFile", status: "pass", code: "env_file_valid" });

  const mergedEnv = {
    ...process.env,
    ...envResult.values
  };

  const postgresUrl = mergedEnv["SWITCHYARD_POSTGRES_URL"]?.trim();
  if (!postgresUrl) {
    checks.push({ name: "postgres", status: "fail", code: "config_required:SWITCHYARD_POSTGRES_URL" });
    return {
      ok: false,
      code: "config_required:SWITCHYARD_POSTGRES_URL",
      checks,
      summary: {
        checkedAt: now().toISOString()
      }
    };
  }

  let handle: PostgresDatabaseHandle | undefined;
  try {
    handle = (deps.openPostgresDatabase ?? openPostgresDatabase)(postgresUrl);
  } catch {
    checks.push({ name: "postgres", status: "fail", code: "postgres_unavailable" });
    return {
      ok: false,
      code: "postgres_unavailable",
      checks,
      summary: {
        checkedAt: now().toISOString()
      }
    };
  }

  try {
    const migration = await (deps.migratePostgresSchema ?? migratePostgresSchema)(handle);
    checks.push({ name: "migration", status: "pass", code: "postgres_schema_ready", diagnostics: { version: migration.version } });
    return {
      ok: true,
      code: "postgres_schema_ready",
      version: migration.version,
      checks,
      summary: {
        checkedAt: now().toISOString()
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "postgres_schema_migration_failed";
    const code = message.startsWith("postgres_") ? message : "postgres_schema_migration_failed";
    checks.push({
      name: "migration",
      status: "fail",
      code,
      diagnostics: redactSecrets({
        postgres: {
          host: safeHost(postgresUrl)
        }
      }) as Record<string, unknown>
    });
    return {
      ok: false,
      code,
      checks,
      summary: {
        checkedAt: now().toISOString()
      }
    };
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
  }
}

function safeHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "invalid";
  }
}

interface ParsedMigrationCliArgs {
  envFile?: string;
  json: boolean;
}

function parseCliArgs(argv: string[]): ParsedMigrationCliArgs {
  const parsed: ParsedMigrationCliArgs = {
    json: true
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) {
      continue;
    }

    if (token === "--env-file") {
      parsed.envFile = argv[index + 1];
      index += 1;
      continue;
    }

    if (token === "--json") {
      parsed.json = true;
      continue;
    }
  }

  return parsed;
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const result = await runProductionMigration({ envFile: args.envFile });

  if (args.json) {
    console.info(JSON.stringify(result));
  } else {
    console.info(JSON.stringify(result));
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
