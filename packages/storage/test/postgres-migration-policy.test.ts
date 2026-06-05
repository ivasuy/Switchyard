import { describe, expect, it } from "vitest";
import { assertPostgresMigrationSqlAdditive } from "../src/index.js";

describe("postgres migration policy", () => {
  it("allows additive create and index statements", () => {
    expect(() => assertPostgresMigrationSqlAdditive("CREATE TABLE IF NOT EXISTS runs (id text PRIMARY KEY)"))
      .not.toThrow();
    expect(() => assertPostgresMigrationSqlAdditive("CREATE INDEX IF NOT EXISTS runs_created_idx ON runs(created_at, id)"))
      .not.toThrow();
    expect(() => assertPostgresMigrationSqlAdditive("ALTER TABLE runs ADD COLUMN runtime_mode text"))
      .not.toThrow();
  });

  it("blocks destructive migration statements", () => {
    expect(() => assertPostgresMigrationSqlAdditive("DROP TABLE runs")).toThrow(/destructive_migration_blocked/i);
    expect(() => assertPostgresMigrationSqlAdditive("ALTER TABLE runs DROP COLUMN runtime_mode"))
      .toThrow(/destructive_migration_blocked/i);
    expect(() => assertPostgresMigrationSqlAdditive("TRUNCATE TABLE run_events"))
      .toThrow(/destructive_migration_blocked/i);
    expect(() => assertPostgresMigrationSqlAdditive("ALTER TABLE runs ALTER COLUMN runtime SET NOT NULL"))
      .toThrow(/destructive_migration_blocked/i);
  });
});
