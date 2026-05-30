import { describe, expect, it } from "vitest";
import { createServerApp } from "../src/app.js";

describe("hosted server", () => {
  it("completes hosted fake run with wait", async () => {
    const app = await createServerApp({ host: "127.0.0.1", port: 0, hostedRuntimeAllowlist: ["fake.deterministic"] });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/runs?wait=1",
        payload: {
          runtime: "fake",
          provider: "test",
          model: "test-model",
          adapterType: "process",
          cwd: "/repo",
          task: "hosted test",
          placement: "hosted"
        }
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().run.status).toBe("completed");
    } finally {
      await app.close();
    }
  });

  it("rejects hosted unsafe runtime", async () => {
    const app = await createServerApp({ host: "127.0.0.1", port: 0, hostedRuntimeAllowlist: [] });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/runs",
        payload: {
          runtime: "fake",
          provider: "test",
          model: "test-model",
          adapterType: "process",
          cwd: "/repo",
          task: "bad mode",
          runtimeMode: "fake.deterministic",
          placement: "hosted"
        }
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("placement_denied");
    } finally {
      await app.close();
    }
  });
});
