import { Readable } from "node:stream";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";

export interface S3CompatibleObjectClientConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  requestTimeoutMs?: number;
  maxAttempts?: number;
}

export interface S3CommandClient {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

export interface S3CompatibleObjectClient {
  putObject(input: { bucket: string; key: string; body: Buffer; contentType: string }): Promise<void>;
  getObject(input: { bucket: string; key: string }): Promise<{ body: Buffer; contentType?: string }>;
  deleteObject(input: { bucket: string; key: string }): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_ATTEMPTS = 2;

export function createS3CompatibleObjectClient(
  config: S3CompatibleObjectClientConfig,
  options?: { client?: S3CommandClient }
): S3CompatibleObjectClient {
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const client = options?.client ?? new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle ?? true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    },
    maxAttempts: config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: requestTimeoutMs,
      requestTimeout: requestTimeoutMs
    })
  });

  return {
    async putObject(input) {
      try {
        await withTimeout(client, requestTimeoutMs, (abortSignal) => client.send(new PutObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType
        }), { abortSignal }));
      } catch (error) {
        throw mapS3Error(error, "put");
      }
    },
    async getObject(input) {
      try {
        return await withTimeout(client, requestTimeoutMs, async (abortSignal) => {
          const output = await client.send(new GetObjectCommand({
            Bucket: input.bucket,
            Key: input.key
          }), { abortSignal });

          const response = output as { Body?: unknown; ContentType?: string };
          if (!response.Body) {
            throw new Error("object_store_read_failed");
          }
          try {
            const body = await toBuffer(response.Body);
            const result: { body: Buffer; contentType?: string } = { body };
            if (response.ContentType !== undefined) {
              result.contentType = response.ContentType;
            }
            return result;
          } catch (error) {
            if (error instanceof Error && error.message === "object_store_timeout") {
              throw error;
            }
            throw new Error("object_store_read_failed");
          }
        });
      } catch (error) {
        throw mapS3Error(error, "get");
      }
    },
    async deleteObject(input) {
      try {
        await withTimeout(client, requestTimeoutMs, (abortSignal) => client.send(new DeleteObjectCommand({
          Bucket: input.bucket,
          Key: input.key
        }), { abortSignal }));
      } catch (error) {
        const mapped = mapS3Error(error, "delete");
        if (mapped.message === "object_store_write_failed") {
          throw new Error("object_store_delete_failed");
        }
        throw mapped;
      }
    }
  };
}

async function toBuffer(body: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (typeof body === "string") {
    return Buffer.from(body);
  }

  const maybeTransform = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof maybeTransform.transformToByteArray === "function") {
    const bytes = await maybeTransform.transformToByteArray();
    return Buffer.from(bytes);
  }

  const maybeArrayBuffer = body as { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof maybeArrayBuffer.arrayBuffer === "function") {
    const bytes = await maybeArrayBuffer.arrayBuffer();
    return Buffer.from(bytes);
  }

  if (body instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks);
  }

  const maybeWebStream = body as {
    getReader?: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }>; releaseLock?: () => void };
  };
  if (typeof maybeWebStream.getReader === "function") {
    const reader = maybeWebStream.getReader();
    const chunks: Buffer[] = [];
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (chunk.value) {
          chunks.push(Buffer.from(chunk.value));
        }
      }
    } finally {
      reader.releaseLock?.();
    }
    return Buffer.concat(chunks);
  }

  throw new Error("object_store_read_failed");
}

async function withTimeout<T>(
  _client: S3CommandClient,
  timeoutMs: number,
  fn: (abortSignal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("object_store_timeout"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fn(controller.signal), timeout]);
  } catch (error) {
    if (
      isAbortError(error) ||
      (error instanceof Error && error.message === "object_store_timeout")
    ) {
      throw new Error("object_store_timeout");
    }
    throw error;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function mapS3Error(error: unknown, operation: "put" | "get" | "delete"): Error {
  if (error instanceof Error && error.message.startsWith("object_store_")) {
    return error;
  }

  const err = error as {
    name?: string;
    message?: string;
    code?: string;
    $metadata?: { httpStatusCode?: number };
  };

  const name = err.name ?? "";
  const message = err.message ?? "";
  const statusCode = err.$metadata?.httpStatusCode;

  if (isAbortError(error)) {
    return new Error("object_store_timeout");
  }
  if (operation === "get" && (name === "NoSuchKey" || name === "NotFound" || statusCode === 404)) {
    return new Error("artifact_content_not_found");
  }
  if (name === "NoSuchBucket") {
    return new Error("object_store_bucket_not_found");
  }
  if (
    statusCode === 401 ||
    statusCode === 403 ||
    name === "AccessDenied" ||
    name === "InvalidAccessKeyId" ||
    name === "SignatureDoesNotMatch" ||
    /signature|access.?key|credential|auth/i.test(message)
  ) {
    return new Error("object_store_auth_failed");
  }
  if (/timeout|timed out/i.test(message)) {
    return new Error("object_store_timeout");
  }
  if (/network|socket|connect|econn|enotfound|eai_again/i.test(message.toLowerCase())) {
    return new Error("object_store_unavailable");
  }
  if (operation === "put") {
    return new Error("object_store_write_failed");
  }
  if (operation === "delete") {
    return new Error("object_store_delete_failed");
  }
  return new Error("object_store_read_failed");
}

function isAbortError(error: unknown): boolean {
  const err = error as { name?: string; code?: string; message?: string };
  if (err?.name === "AbortError" || err?.code === "ABORT_ERR") {
    return true;
  }
  return Boolean(err?.message && /abort|aborted/i.test(err.message));
}
