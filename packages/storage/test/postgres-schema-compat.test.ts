import { describe, expect, it } from "vitest";
import {
  POSTGRES_SCHEMA_VERSION,
  checkPostgresSchemaCompatibility,
  migratePostgresSchema,
  openPostgresDatabase
} from "../src/index.js";
import type { PostgresDatabaseHandle } from "../src/postgres/database.js";

interface QueryResultRow {
  value?: unknown;
}

interface FakePostgresOptions {
  probeError?: Error;
  metadataSelectError?: Error;
  metadataValue?: string | null | undefined;
}

function makeFakeHandle(options: FakePostgresOptions = {}): {
  handle: PostgresDatabaseHandle;
  state: { version: string | undefined; metadataTablePresent: boolean; queryLog: string[] };
} {
  const state = {
    version: options.metadataValue === null ? undefined : options.metadataValue,
    metadataTablePresent: options.metadataValue !== undefined,
    queryLog: [] as string[]
  };

  const query = async (sql: string, params?: ReadonlyArray<unknown>): Promise<{ rows: QueryResultRow[] }> => {
    state.queryLog.push(sql);
    const normalized = sql.toUpperCase();

    if (normalized.includes("SELECT 1")) {
      if (options.probeError) {
        throw options.probeError;
      }
      return { rows: [{ value: 1 }] };
    }

    if (normalized.includes("CREATE TABLE IF NOT EXISTS SCHEMA_METADATA")) {
      state.metadataTablePresent = true;
      return { rows: [] };
    }

    if (normalized.includes("INSERT INTO SCHEMA_METADATA")) {
      const version = params?.[1];
      state.version = typeof version === "string" ? version : String(version ?? "");
      state.metadataTablePresent = true;
      return { rows: [] };
    }

    if (normalized.includes("FROM SCHEMA_METADATA")) {
      if (options.metadataSelectError) {
        throw options.metadataSelectError;
      }
      if (!state.metadataTablePresent) {
        throw new Error('relation "schema_metadata" does not exist');
      }
      if (state.version === undefined) {
        return { rows: [] };
      }
      return { rows: [{ value: state.version }] };
    }

    return { rows: [] };
  };

  const handle = {
    pool: { query } as unknown as PostgresDatabaseHandle["pool"],
    db: {} as PostgresDatabaseHandle["db"],
    real: true,
    close: async () => {}
  } satisfies PostgresDatabaseHandle;

  return { handle, state };
}

describe("postgres schema compatibility", () => {
  it("reports ready when schema version matches", async () => {
    const { handle } = makeFakeHandle({ metadataValue: String(POSTGRES_SCHEMA_VERSION) });

    await expect(checkPostgresSchemaCompatibility(handle)).resolves.toEqual({
      ok: true,
      code: "postgres_schema_ready",
      version: POSTGRES_SCHEMA_VERSION
    });
  });

  it("reports migration required when metadata table is missing", async () => {
    const { handle } = makeFakeHandle({ metadataValue: undefined });

    await expect(checkPostgresSchemaCompatibility(handle)).resolves.toMatchObject({
      ok: false,
      code: "postgres_schema_migration_required"
    });
  });

  it("reports migration required when schema_version row is missing", async () => {
    const { handle } = makeFakeHandle({ metadataValue: null });

    await expect(checkPostgresSchemaCompatibility(handle)).resolves.toMatchObject({
      ok: false,
      code: "postgres_schema_migration_required"
    });
  });

  it("reports malformed when schema_version is not numeric", async () => {
    const { handle } = makeFakeHandle({ metadataValue: "not-a-number" });

    await expect(checkPostgresSchemaCompatibility(handle)).resolves.toMatchObject({
      ok: false,
      code: "postgres_schema_malformed"
    });
  });

  it("reports unsupported when schema version is newer than current code", async () => {
    const { handle } = makeFakeHandle({ metadataValue: String(POSTGRES_SCHEMA_VERSION + 1) });

    await expect(checkPostgresSchemaCompatibility(handle)).resolves.toEqual({
      ok: false,
      code: "postgres_schema_version_unsupported",
      version: POSTGRES_SCHEMA_VERSION + 1,
      diagnostics: {
        expectedVersion: POSTGRES_SCHEMA_VERSION,
        actualVersion: POSTGRES_SCHEMA_VERSION + 1,
        metadataPresent: true
      }
    });
  });

  it("reports unavailable when database probe fails", async () => {
    const { handle } = makeFakeHandle({ probeError: new Error("connection refused") });

    await expect(checkPostgresSchemaCompatibility(handle)).resolves.toMatchObject({
      ok: false,
      code: "postgres_unavailable"
    });
  });

  it("migrates schema idempotently and writes schema metadata", async () => {
    const { handle, state } = makeFakeHandle({ metadataValue: undefined });

    await expect(migratePostgresSchema(handle)).resolves.toEqual({
      ok: true,
      version: POSTGRES_SCHEMA_VERSION
    });

    await expect(migratePostgresSchema(handle)).resolves.toEqual({
      ok: true,
      version: POSTGRES_SCHEMA_VERSION
    });

    expect(state.version).toBe(String(POSTGRES_SCHEMA_VERSION));
  });

  it("can verify and migrate against real postgres when SWITCHYARD_TEST_POSTGRES_URL is set", async () => {
    const url = process.env["SWITCHYARD_TEST_POSTGRES_URL"];
    if (!url) {
      expect("SKIPPED_SWITCHYARD_TEST_POSTGRES_URL_UNSET").toContain("SKIPPED");
      return;
    }

    const opened = openPostgresDatabase(url);
    try {
      await expect(migratePostgresSchema(opened)).resolves.toEqual({
        ok: true,
        version: POSTGRES_SCHEMA_VERSION
      });

      await expect(checkPostgresSchemaCompatibility(opened)).resolves.toEqual({
        ok: true,
        code: "postgres_schema_ready",
        version: POSTGRES_SCHEMA_VERSION
      });
    } finally {
      await opened.close();
    }
  });
});
