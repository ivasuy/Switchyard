import { describe, expect, it } from "vitest";
import { PostgresHostedRuntimeBridgePayloadStore } from "../src/index.js";
import type { PostgresDatabaseHandle } from "../src/postgres/database.js";

describe("postgres hosted runtime bridge payload store", () => {
  it("shares payload handoff across independent store instances via shared postgres handle", async () => {
    const rows = new Map<string, { payload: Record<string, unknown>; createdAt: string; updatedAt: string }>();
    const handle = createPayloadStoreHandle(rows);

    const serverStore = new PostgresHostedRuntimeBridgePayloadStore(handle);
    const workerStore = new PostgresHostedRuntimeBridgePayloadStore(handle);

    await serverStore.put({
      commandId: "bridge_cmd_1",
      payload: { text: "continue", type: "input" }
    });

    const fromWorker = await workerStore.get("bridge_cmd_1");
    expect(fromWorker).toEqual({ text: "continue", type: "input" });

    await workerStore.delete("bridge_cmd_1");
    expect(await serverStore.get("bridge_cmd_1")).toBeUndefined();
  });
});

function createPayloadStoreHandle(
  rows: Map<string, { payload: Record<string, unknown>; createdAt: string; updatedAt: string }>
): PostgresDatabaseHandle {
  return {
    pool: {
      query: async (sql: string, params?: ReadonlyArray<unknown>) => {
        if (!params) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("INSERT INTO hosted_runtime_bridge_payloads")) {
          const commandId = String(params[0]);
          const payload = params[1] as Record<string, unknown>;
          const createdAt = String(params[2]);
          const updatedAt = String(params[3]);
          const existing = rows.get(commandId);
          rows.set(commandId, {
            payload,
            createdAt: existing?.createdAt ?? createdAt,
            updatedAt
          });
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("DELETE FROM hosted_runtime_bridge_payloads")) {
          const commandId = String(params[0]);
          const existed = rows.delete(commandId);
          return { rows: [], rowCount: existed ? 1 : 0 };
        }
        if (sql.includes("FROM hosted_runtime_bridge_payloads")) {
          const commandId = String(params[0]);
          const row = rows.get(commandId);
          return { rows: row ? [{ payload: row.payload }] : [], rowCount: row ? 1 : 0 };
        }
        return { rows: [], rowCount: 0 };
      }
    } as PostgresDatabaseHandle["pool"],
    db: {} as PostgresDatabaseHandle["db"],
    real: true,
    close: async () => {}
  };
}
