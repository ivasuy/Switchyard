import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerErrorEnvelope } from "./http-errors.js";

describe("http error request ids", () => {
  it("attaches requestId and x-request-id for validation failures", async () => {
    const app = Fastify();
    registerErrorEnvelope(app);
    app.post("/input", async () => {
      throw Object.assign(new Error("bad payload"), { statusCode: 400 });
    });

    const response = await app.inject({ method: "POST", url: "/input" });
    expect(response.statusCode).toBe(400);
    expect(response.headers["x-request-id"]).toBeTruthy();
    expect(response.json().error.requestId).toBe(response.headers["x-request-id"]);
  });

  it("attaches requestId for not found routes", async () => {
    const app = Fastify();
    registerErrorEnvelope(app);

    const response = await app.inject({ method: "GET", url: "/missing" });
    expect(response.statusCode).toBe(404);
    expect(response.headers["x-request-id"]).toBeTruthy();
    expect(response.json().error.requestId).toBe(response.headers["x-request-id"]);
  });
});
