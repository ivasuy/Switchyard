import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { httpErrorCodeSchema, httpErrorEnvelopeSchema } from "./http-error.js";

function protocolErrorCodes(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const protocolFile = join(here, "../../protocol-rest/src/http-errors.ts");
  const source = readFileSync(protocolFile, "utf8");
  const match = source.match(/export type HttpErrorCode =([\s\S]*?)\n\nexport interface HttpErrorDetail/);
  if (!match || !match[1]) {
    throw new Error("failed to locate protocol-rest HttpErrorCode union");
  }
  return [...match[1].matchAll(/\|\s+"([a-z0-9_]+)"/g)].map((entry) => entry[1] ?? "").filter(Boolean).sort();
}

describe("http error contract", () => {
  it("accepts requestId in the HTTP error envelope", () => {
    const parsed = httpErrorEnvelopeSchema.parse({
      error: {
        code: "run_not_found",
        message: "missing",
        requestId: "req_123"
      }
    });
    expect(parsed.error.requestId).toBe("req_123");
  });

  it("matches all protocol-rest HTTP error codes", () => {
    const contractCodes = [...httpErrorCodeSchema.options].sort();
    const routeCodes = protocolErrorCodes();

    expect(contractCodes).toEqual(routeCodes);
  });
});
