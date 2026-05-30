import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createS3CompatibleObjectClient } from "../src/s3-compatible-object-client.js";

describe("s3-compatible object client", () => {
  it("sends put/get/delete commands through injected SDK client", async () => {
    const commands: string[] = [];
    const client = createS3CompatibleObjectClient(
      {
        endpoint: "https://s3.us-east-1.amazonaws.com",
        region: "us-east-1",
        accessKeyId: "key",
        secretAccessKey: "secret",
        requestTimeoutMs: 100
      },
      {
        client: {
          async send(command: unknown) {
            commands.push((command as { constructor: { name: string } }).constructor.name);
            if ((command as { constructor: { name: string } }).constructor.name === "GetObjectCommand") {
              return { Body: Buffer.from("hello"), ContentType: "text/plain" };
            }
            return {};
          }
        }
      }
    );

    await client.putObject({ bucket: "b", key: "k", body: Buffer.from("x"), contentType: "text/plain" });
    const got = await client.getObject({ bucket: "b", key: "k" });
    await client.deleteObject({ bucket: "b", key: "k" });

    expect(commands).toEqual(["PutObjectCommand", "GetObjectCommand", "DeleteObjectCommand"]);
    expect(got.body.toString("utf8")).toBe("hello");
    expect(got.contentType).toBe("text/plain");
  });

  it("converts different GetObject body shapes to Buffer", async () => {
    const cases: Array<{ name: string; body: unknown }> = [
      { name: "buffer", body: Buffer.from("alpha") },
      { name: "uint8array", body: new Uint8Array(Buffer.from("beta")) },
      { name: "transformToByteArray", body: { async transformToByteArray() { return new Uint8Array(Buffer.from("gamma")); } } },
      { name: "arrayBuffer", body: { async arrayBuffer() { return Buffer.from("delta").buffer.slice(0); } } },
      { name: "node stream", body: Readable.from([Buffer.from("eps"), Buffer.from("ilon")]) },
      {
        name: "web stream",
        body: {
          getReader() {
            const chunks = [new Uint8Array(Buffer.from("ze")), new Uint8Array(Buffer.from("ta"))];
            return {
              async read() {
                const value = chunks.shift();
                return value ? { done: false, value } : { done: true };
              },
              releaseLock() {
                return undefined;
              }
            };
          }
        }
      }
    ];

    for (const entry of cases) {
      const objectClient = createS3CompatibleObjectClient(
        {
          endpoint: "https://s3.us-east-1.amazonaws.com",
          region: "us-east-1",
          accessKeyId: "key",
          secretAccessKey: "secret",
          requestTimeoutMs: 100
        },
        {
          client: {
            async send(command: unknown) {
              if ((command as { constructor: { name: string } }).constructor.name === "GetObjectCommand") {
                return { Body: entry.body, ContentType: "application/octet-stream" };
              }
              return {};
            }
          }
        }
      );

      const output = await objectClient.getObject({ bucket: "b", key: "k" });
      expect(Buffer.isBuffer(output.body), entry.name).toBe(true);
      expect(output.body.byteLength, entry.name).toBeGreaterThan(0);
    }
  });

  it("maps conversion failures and undefined body to object_store_read_failed", async () => {
    const undefinedBodyClient = createS3CompatibleObjectClient(
      {
        endpoint: "https://s3.us-east-1.amazonaws.com",
        region: "us-east-1",
        accessKeyId: "key",
        secretAccessKey: "secret",
        requestTimeoutMs: 100
      },
      {
        client: {
          async send() {
            return { Body: undefined };
          }
        }
      }
    );

    await expect(undefinedBodyClient.getObject({ bucket: "b", key: "k" })).rejects.toThrow("object_store_read_failed");

    const failingBodyClient = createS3CompatibleObjectClient(
      {
        endpoint: "https://s3.us-east-1.amazonaws.com",
        region: "us-east-1",
        accessKeyId: "key",
        secretAccessKey: "secret",
        requestTimeoutMs: 100
      },
      {
        client: {
          async send() {
            return {
              Body: {
                async transformToByteArray() {
                  throw new Error("bad stream");
                }
              }
            };
          }
        }
      }
    );

    await expect(failingBodyClient.getObject({ bucket: "b", key: "k" })).rejects.toThrow("object_store_read_failed");
  });

  it("maps timeout, auth, bucket, and missing-content failures", async () => {
    const timeoutClient = createS3CompatibleObjectClient(
      {
        endpoint: "https://s3.us-east-1.amazonaws.com",
        region: "us-east-1",
        accessKeyId: "key",
        secretAccessKey: "secret",
        requestTimeoutMs: 10
      },
      {
        client: {
          send(_command: unknown, options?: { abortSignal?: AbortSignal }) {
            return new Promise((_resolve, reject) => {
              options?.abortSignal?.addEventListener("abort", () => {
                reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
              });
            });
          }
        }
      }
    );
    await expect(timeoutClient.putObject({ bucket: "b", key: "k", body: Buffer.from("x"), contentType: "text/plain" }))
      .rejects.toThrow("object_store_timeout");

    const authClient = createS3CompatibleObjectClient(
      {
        endpoint: "https://s3.us-east-1.amazonaws.com",
        region: "us-east-1",
        accessKeyId: "key",
        secretAccessKey: "secret",
        requestTimeoutMs: 100
      },
      {
        client: {
          async send() {
            throw { name: "AccessDenied", message: "signature invalid", $metadata: { httpStatusCode: 403 } };
          }
        }
      }
    );
    await expect(authClient.putObject({ bucket: "b", key: "k", body: Buffer.from("x"), contentType: "text/plain" }))
      .rejects.toThrow("object_store_auth_failed");

    const bucketClient = createS3CompatibleObjectClient(
      {
        endpoint: "https://s3.us-east-1.amazonaws.com",
        region: "us-east-1",
        accessKeyId: "key",
        secretAccessKey: "secret",
        requestTimeoutMs: 100
      },
      {
        client: {
          async send() {
            throw { name: "NoSuchBucket", message: "missing" };
          }
        }
      }
    );
    await expect(bucketClient.putObject({ bucket: "b", key: "k", body: Buffer.from("x"), contentType: "text/plain" }))
      .rejects.toThrow("object_store_bucket_not_found");

    const missingClient = createS3CompatibleObjectClient(
      {
        endpoint: "https://s3.us-east-1.amazonaws.com",
        region: "us-east-1",
        accessKeyId: "key",
        secretAccessKey: "secret",
        requestTimeoutMs: 100
      },
      {
        client: {
          async send() {
            throw { name: "NoSuchKey", message: "missing", $metadata: { httpStatusCode: 404 } };
          }
        }
      }
    );
    await expect(missingClient.getObject({ bucket: "b", key: "k" })).rejects.toThrow("artifact_content_not_found");
  });

  it("times out getObject when body reader never resolves", async () => {
    const client = createS3CompatibleObjectClient(
      {
        endpoint: "https://s3.us-east-1.amazonaws.com",
        region: "us-east-1",
        accessKeyId: "key",
        secretAccessKey: "secret",
        requestTimeoutMs: 25
      },
      {
        client: {
          async send(command: unknown) {
            if ((command as { constructor: { name: string } }).constructor.name !== "GetObjectCommand") {
              return {};
            }
            return {
              Body: {
                getReader() {
                  return {
                    async read() {
                      return new Promise<{ done: boolean; value?: Uint8Array }>(() => {});
                    },
                    releaseLock() {
                      return undefined;
                    }
                  };
                }
              }
            };
          }
        }
      }
    );

    await expect(client.getObject({ bucket: "b", key: "k" })).rejects.toThrow("object_store_timeout");
  }, 1000);
});
