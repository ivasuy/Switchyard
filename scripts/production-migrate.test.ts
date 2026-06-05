import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test, vi } from "vitest";
import { runProductionMigration } from "./production-migrate.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "switchyard-production-migrate-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("runProductionMigration", () => {
  test("returns env_file_missing and does not open postgres when env file is missing", async () => {
    const openPostgresDatabase = vi.fn();

    const result = await runProductionMigration({
      envFile: "/definitely/missing.env",
      deps: {
        openPostgresDatabase
      }
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("env_file_missing");
    expect(openPostgresDatabase).not.toHaveBeenCalled();
  });

  test("returns env_duplicate_key and skips migration", async () => {
    await withTempDir(async (dir) => {
      const envPath = join(dir, "duplicate.env");
      await writeFile(envPath, "SWITCHYARD_POSTGRES_URL=postgres://a\nSWITCHYARD_POSTGRES_URL=postgres://b\n", "utf8");

      const migratePostgresSchema = vi.fn();
      const result = await runProductionMigration({
        envFile: envPath,
        deps: {
          migratePostgresSchema
        }
      });

      expect(result.ok).toBe(false);
      expect(result.code).toBe("env_duplicate_key");
      expect(migratePostgresSchema).not.toHaveBeenCalled();
    });
  });

  test("delegates to migratePostgresSchema and stays idempotent", async () => {
    await withTempDir(async (dir) => {
      const envPath = join(dir, "ok.env");
      await writeFile(envPath, "SWITCHYARD_POSTGRES_URL=postgres://user:pw@db.example:5432/switchyard\n", "utf8");

      const close = vi.fn(async () => undefined);
      const openPostgresDatabase = vi.fn(() => ({ close }));
      const migratePostgresSchema = vi.fn(async () => ({ ok: true, version: 19 }));

      const first = await runProductionMigration({
        envFile: envPath,
        deps: {
          openPostgresDatabase,
          migratePostgresSchema
        }
      });

      const second = await runProductionMigration({
        envFile: envPath,
        deps: {
          openPostgresDatabase,
          migratePostgresSchema
        }
      });

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(first.version).toBe(19);
      expect(second.version).toBe(19);
      expect(migratePostgresSchema).toHaveBeenCalledTimes(2);
      expect(close).toHaveBeenCalledTimes(2);
    });
  });

  test("returns postgres_unavailable when opening postgres fails", async () => {
    await withTempDir(async (dir) => {
      const envPath = join(dir, "ok.env");
      await writeFile(envPath, "SWITCHYARD_POSTGRES_URL=postgres://user:pw@db.example:5432/switchyard\n", "utf8");

      const result = await runProductionMigration({
        envFile: envPath,
        deps: {
          openPostgresDatabase: () => {
            throw new Error("connect failed");
          }
        }
      });

      expect(result.ok).toBe(false);
      expect(result.code).toBe("postgres_unavailable");
    });
  });

  test("returns postgres_schema_migration_failed when migration throws", async () => {
    await withTempDir(async (dir) => {
      const envPath = join(dir, "ok.env");
      await writeFile(envPath, "SWITCHYARD_POSTGRES_URL=postgres://user:pw@db.example:5432/switchyard\n", "utf8");

      const close = vi.fn(async () => undefined);
      const result = await runProductionMigration({
        envFile: envPath,
        deps: {
          openPostgresDatabase: () => ({ close }) as never,
          migratePostgresSchema: async () => {
            throw new Error("migration exploded");
          }
        }
      });

      expect(result.ok).toBe(false);
      expect(result.code).toBe("postgres_schema_migration_failed");
      expect(close).toHaveBeenCalledTimes(1);
    });
  });
});
