import { describe, expect, it } from "vitest";

import { openSqliteStorage } from "../src/index.js";

describe("storage package", () => {
  it("opens sqlite storage and executes a query", () => {
    const opened = openSqliteStorage(":memory:");

    try {
      const row = opened.sqlite.prepare("SELECT 1 AS value").get() as { value: number };
      expect(opened).toHaveProperty("sqlite");
      expect(opened).toHaveProperty("db");
      expect(row.value).toBe(1);
    } finally {
      opened.sqlite.close();
    }
  });
});
