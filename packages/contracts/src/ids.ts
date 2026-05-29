import { z } from "zod";

export const idSchema = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`), `Expected ${prefix}_ prefixed id`);

export const runIdSchema = idSchema("run");
export const sessionIdSchema = idSchema("session");
export const debateIdSchema = idSchema("debate");
export const participantIdSchema = idSchema("participant");
export const messageIdSchema = idSchema("message");
export const eventIdSchema = idSchema("event");
export const artifactIdSchema = idSchema("artifact");
export const approvalIdSchema = idSchema("approval");
export const providerIdSchema = idSchema("provider");
export const modelIdSchema = idSchema("model");
export const runtimeIdSchema = idSchema("runtime");
export const runtimeModeIdSchema = idSchema("runtime_mode");
export const nodeIdSchema = idSchema("node");
export const memoryIdSchema = idSchema("memory");
export const evidenceIdSchema = idSchema("evidence");
export const toolInvocationIdSchema = idSchema("tool");
export const userIdSchema = idSchema("user");
export const organizationIdSchema = idSchema("org");
export const contextPacketIdSchema = idSchema("context");

export const isoDateSchema = z.string().datetime({ offset: true });
export const metadataSchema = z.record(z.string(), z.unknown());
export const runtimeModeSlugSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)+$/,
    "must be a dot-separated lowercase runtime mode slug"
  );
