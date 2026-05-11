import { describe, expect, it } from "vitest";
import { createDaemonApp } from "../src/app.js";

describe("daemon app", () => {
  it("creates a fake run through the local REST API", async () => {
    const app = createDaemonApp();

    const response = await app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        runtime: "fake",
        provider: "test",
        model: "test-model",
        adapterType: "process",
        cwd: "/repo",
        task: "Smoke test run"
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().run.status).toBe("completed");
  });
});
