import { z } from "zod";
import { adapterTypeSchema, executionPlacementSchema, runSchema, runStatusSchema } from "./run.js";
import {
  modelSchema,
  providerSchema,
  runtimeAvailabilityStateSchema,
  runtimeModeKindSchema,
  runtimeModeSchema,
  runtimeSchema
} from "./registry.js";

export const LIST_LIMIT_DEFAULT = 50;
export const LIST_LIMIT_MAX = 200;

const slugSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a well-formed slug");

function csv<T extends z.ZodType>(item: T) {
  return z
    .preprocess((value) => {
      if (value === undefined || value === null || value === "") {
        return undefined;
      }
      if (Array.isArray(value)) {
        return value.flatMap((entry) =>
          typeof entry === "string" ? entry.split(",").map((part) => part.trim()).filter((part) => part.length > 0) : []
        );
      }
      if (typeof value !== "string") {
        return value;
      }
      return value
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    }, z.array(item).min(1))
    .optional();
}

const limitSchema = z
  .preprocess((value) => {
    if (value === undefined || value === null || value === "") {
      return undefined;
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : value;
    }
    return value;
  }, z.number().int().positive().max(LIST_LIMIT_MAX))
  .optional();

const cursorStringSchema = z.string().min(1).optional();

const isoSchema = z.string().datetime({ offset: true }).optional();

export const listRunsQuerySchema = z.object({
  status: csv(runStatusSchema),
  runtime: csv(slugSchema),
  provider: csv(slugSchema),
  model: csv(slugSchema),
  placement: csv(executionPlacementSchema),
  adapterType: csv(adapterTypeSchema),
  since: isoSchema,
  until: isoSchema,
  limit: limitSchema,
  before: cursorStringSchema
});

export const listProvidersQuerySchema = z.object({
  limit: limitSchema,
  before: cursorStringSchema
});

export const listRuntimesQuerySchema = z.object({
  provider: csv(slugSchema),
  adapterType: csv(adapterTypeSchema),
  limit: limitSchema,
  before: cursorStringSchema
});

export const listModelsQuerySchema = z.object({
  provider: csv(slugSchema),
  limit: limitSchema,
  before: cursorStringSchema
});

export const listRuntimeModesQuerySchema = z.object({
  provider: csv(slugSchema),
  runtime: csv(slugSchema),
  adapterType: csv(adapterTypeSchema),
  kind: csv(runtimeModeKindSchema),
  availability: csv(runtimeAvailabilityStateSchema),
  placement: csv(executionPlacementSchema),
  capability: csv(z.string().min(1)),
  limit: limitSchema,
  before: cursorStringSchema
});

export const listRunsResponseSchema = z.object({
  runs: z.array(runSchema),
  nextCursor: z.string().nullable()
});

export const listProvidersResponseSchema = z.object({
  providers: z.array(providerSchema),
  nextCursor: z.string().nullable()
});

export const listRuntimesResponseSchema = z.object({
  runtimes: z.array(runtimeSchema),
  nextCursor: z.string().nullable()
});

export const listModelsResponseSchema = z.object({
  models: z.array(modelSchema),
  nextCursor: z.string().nullable()
});

export const listRuntimeModesResponseSchema = z.object({
  runtimeModes: z.array(runtimeModeSchema),
  nextCursor: z.string().nullable()
});

const doctorRuntimeModeSummaryEntrySchema = z.object({
  runtimeModeId: z.string().min(1),
  runtimeMode: z.string().min(1),
  state: runtimeAvailabilityStateSchema,
  canRun: z.boolean(),
  checkedAt: z.string().datetime({ offset: true })
});

export const doctorSummaryResponseSchema = z.object({
  runtimeModes: z.array(doctorRuntimeModeSummaryEntrySchema),
  summary: z.object({
    available: z.number().int().nonnegative(),
    installed: z.number().int().nonnegative(),
    partial: z.number().int().nonnegative(),
    unavailable: z.number().int().nonnegative(),
    unsupported: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative()
  })
});

export type ListRunsQuery = z.infer<typeof listRunsQuerySchema>;
export type ListProvidersQuery = z.infer<typeof listProvidersQuerySchema>;
export type ListRuntimesQuery = z.infer<typeof listRuntimesQuerySchema>;
export type ListModelsQuery = z.infer<typeof listModelsQuerySchema>;
export type ListRuntimeModesQuery = z.infer<typeof listRuntimeModesQuerySchema>;
export type ListRunsResponse = z.infer<typeof listRunsResponseSchema>;
export type ListProvidersResponse = z.infer<typeof listProvidersResponseSchema>;
export type ListRuntimesResponse = z.infer<typeof listRuntimesResponseSchema>;
export type ListModelsResponse = z.infer<typeof listModelsResponseSchema>;
export type ListRuntimeModesResponse = z.infer<typeof listRuntimeModesResponseSchema>;
export type DoctorSummaryResponse = z.infer<typeof doctorSummaryResponseSchema>;
