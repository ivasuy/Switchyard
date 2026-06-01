import { z } from "zod";

const ACP_PERMISSION_REQUEST_MAX_PARAMS_BYTES = 64 * 1024;

export const acpInitializeParamsSchema = z.object({
  protocolVersion: z.number().int().positive(),
  clientCapabilities: z.record(z.string(), z.unknown()).optional(),
  clientInfo: z.object({
    name: z.string().min(1),
    title: z.string().min(1).optional(),
    version: z.string().min(1)
  }).passthrough()
}).passthrough();

export const acpInitializeResultSchema = z.object({
  protocolVersion: z.number().int().positive(),
  agentCapabilities: z.record(z.string(), z.unknown()).optional(),
  agentInfo: z.object({
    name: z.string().min(1),
    version: z.string().min(1).optional()
  }).passthrough(),
  authMethods: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1).optional()
  }).passthrough()).optional()
}).passthrough();

export const acpSessionNewParamsSchema = z.object({
  cwd: z.string().min(1),
  mcpServers: z.array(z.unknown()).default([])
}).passthrough();

export const acpSessionNewResultSchema = z.object({
  sessionId: z.string().min(1),
  models: z.object({
    currentModelId: z.string().min(1).optional(),
    availableModels: z.array(
      z.object({
        modelId: z.string().min(1),
        name: z.string().min(1).optional()
      }).passthrough()
    ).optional()
  }).passthrough().optional(),
  modes: z.object({
    currentModeId: z.string().min(1).optional(),
    availableModes: z.array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1).optional(),
        description: z.string().optional()
      }).passthrough()
    ).optional()
  }).passthrough().optional(),
  _meta: z.record(z.string(), z.unknown()).optional()
}).passthrough();

export const acpPromptBlockSchema = z.object({
  type: z.string().min(1),
  text: z.string().optional()
}).passthrough();

export const acpSessionPromptParamsSchema = z.object({
  sessionId: z.string().min(1),
  prompt: z.array(acpPromptBlockSchema).min(1)
}).passthrough();

export const acpSessionPromptResultSchema = z.object({
  stopReason: z.string().min(1)
}).passthrough();

export const acpSessionCancelParamsSchema = z.object({
  sessionId: z.string().min(1)
}).passthrough();

export const acpSessionUpdateSchema = z.object({
  sessionUpdate: z.string().min(1)
}).passthrough();

export const acpSessionUpdateNotificationSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.literal("session/update"),
  params: z.object({
    sessionId: z.string().min(1).optional(),
    update: acpSessionUpdateSchema
  }).passthrough()
}).passthrough();

export const acpAgentRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string().min(1), z.number().finite()]),
  method: z.string().min(1),
  params: z.unknown().optional()
}).passthrough();

const acpPermissionRequestParamsSchema = z.object({
  sessionId: z.string().min(1).optional(),
  expiresAt: z.string().datetime().optional()
}).passthrough().superRefine((params, context) => {
  const serialized = JSON.stringify(params);
  if (!serialized) {
    return;
  }
  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength > ACP_PERMISSION_REQUEST_MAX_PARAMS_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "permission request params exceed max bytes",
      path: ["params"]
    });
  }
});

export const acpPermissionRequestSchema = acpAgentRequestSchema.extend({
  method: z.literal("session/request_permission"),
  params: acpPermissionRequestParamsSchema.optional()
});
