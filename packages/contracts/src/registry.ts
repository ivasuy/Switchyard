import { z } from "zod";
import { adapterTypeSchema } from "./run.js";
import {
  isoDateSchema,
  providerIdSchema,
  runtimeIdSchema,
  runtimeModeIdSchema,
  runtimeModeSlugSchema
} from "./ids.js";

export const registryStatusSchema = z.enum(["available", "unavailable", "degraded", "unknown"]);
export const authModeSchema = z.enum(["none", "local", "api_key", "oauth", "custom"]);

export const providerSchema = z.object({
  id: providerIdSchema,
  name: z.string().min(1),
  authMode: authModeSchema,
  status: registryStatusSchema
});

export const runtimeSchema = z.object({
  id: runtimeIdSchema,
  name: z.string().min(1),
  adapterType: adapterTypeSchema,
  status: registryStatusSchema,
  providerId: providerIdSchema.optional()
});

export const modelSchema = z.object({
  id: z.string().min(1),
  providerId: providerIdSchema,
  modelName: z.string().min(1),
  supportsTools: z.boolean().default(false),
  supportsStreaming: z.boolean().default(false),
  supportsBrowser: z.boolean().default(false),
  status: registryStatusSchema
});

export const runtimeModeKindSchema = z.enum([
  "deterministic_fake",
  "one_shot_process",
  "interactive_process",
  "pty",
  "acp",
  "sdk",
  "sync_http",
  "async_rest",
  "browser_backed"
]);

export const runtimeCapabilitySchema = z.enum([
  "run.start",
  "run.cancel",
  "run.timeout",
  "event.normalized",
  "event.streaming",
  "artifact.transcript",
  "artifact.raw_transcript",
  "model.catalog",
  "tool.fake_echo",
  "auth.none",
  "auth.local",
  "sandbox.read_only",
  "sandbox.workspace_write",
  "sandbox.danger_full_access"
]);

export const runtimeLimitationSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1)
});

export const runtimePlacementSupportSchema = z.enum(["supported", "unsupported", "conditional", "future", "unknown"]);

export const runtimePlacementFactSchema = z.object({
  support: runtimePlacementSupportSchema,
  reason: z.string().min(1)
});

export const runtimePlacementFactsSchema = z.object({
  local: runtimePlacementFactSchema,
  hosted: runtimePlacementFactSchema,
  connectedLocalNode: runtimePlacementFactSchema
});

export const runtimeAvailabilityStateSchema = z.enum([
  "available",
  "installed",
  "unavailable",
  "unsupported",
  "partial",
  "unknown"
]);

export const runtimeAvailabilityAuthSchema = z.enum(["not_required", "configured", "missing", "unknown"]);

export const runtimeAvailabilitySchema = z.object({
  state: runtimeAvailabilityStateSchema,
  canRun: z.boolean(),
  installed: z.boolean(),
  auth: runtimeAvailabilityAuthSchema,
  version: z.string().min(1).nullable(),
  checkedAt: isoDateSchema,
  reasonCode: z.string().min(1).nullable(),
  message: z.string().min(1).nullable()
});

export const runtimeDoctorDiagnosticSchema = z.object({
  code: z.string().min(1),
  severity: z.enum(["info", "warning", "error"]),
  message: z.string().min(1)
});

export const runtimeDoctorCheckSchema = z.object({
  runtimeModeId: runtimeModeIdSchema,
  runtimeMode: runtimeModeSlugSchema,
  providerId: providerIdSchema,
  runtimeId: runtimeIdSchema,
  state: runtimeAvailabilityStateSchema,
  canRun: z.boolean(),
  installed: z.boolean(),
  auth: runtimeAvailabilityAuthSchema,
  version: z.string().min(1).nullable(),
  checkedAt: isoDateSchema,
  reasonCode: z.string().min(1).nullable(),
  message: z.string().min(1).nullable(),
  capabilities: z.array(runtimeCapabilitySchema),
  limitations: z.array(runtimeLimitationSchema),
  diagnostics: z.array(runtimeDoctorDiagnosticSchema)
});

export const runtimeModeSchema = z.object({
  id: runtimeModeIdSchema,
  slug: runtimeModeSlugSchema,
  name: z.string().min(1),
  providerId: providerIdSchema,
  runtimeId: runtimeIdSchema,
  adapterId: z.string().min(1),
  adapterType: adapterTypeSchema,
  kind: runtimeModeKindSchema,
  status: runtimeAvailabilityStateSchema,
  capabilities: z.array(runtimeCapabilitySchema).min(1),
  limitations: z.array(runtimeLimitationSchema),
  placement: runtimePlacementFactsSchema,
  availability: runtimeAvailabilitySchema,
  docsPath: z.string().min(1).optional(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema
});

export type Provider = z.infer<typeof providerSchema>;
export type RuntimeTarget = z.infer<typeof runtimeSchema>;
export type Model = z.infer<typeof modelSchema>;
export type RuntimeModeKind = z.infer<typeof runtimeModeKindSchema>;
export type RuntimeCapability = z.infer<typeof runtimeCapabilitySchema>;
export type RuntimeLimitation = z.infer<typeof runtimeLimitationSchema>;
export type RuntimePlacementSupport = z.infer<typeof runtimePlacementSupportSchema>;
export type RuntimePlacementFacts = z.infer<typeof runtimePlacementFactsSchema>;
export type RuntimeAvailabilityState = z.infer<typeof runtimeAvailabilityStateSchema>;
export type RuntimeAvailability = z.infer<typeof runtimeAvailabilitySchema>;
export type RuntimeDoctorDiagnostic = z.infer<typeof runtimeDoctorDiagnosticSchema>;
export type RuntimeDoctorCheck = z.infer<typeof runtimeDoctorCheckSchema>;
export type RuntimeMode = z.infer<typeof runtimeModeSchema>;
