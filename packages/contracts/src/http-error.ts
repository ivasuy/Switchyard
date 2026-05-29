import { z } from "zod";

export const httpErrorCodeSchema = z.enum([
  "run_not_found",
  "artifact_not_found",
  "missing_artifact_content",
  "provider_not_found",
  "runtime_not_found",
  "runtime_mode_not_found",
  "model_not_found",
  "invalid_input",
  "invalid_query",
  "adapter_protocol_failed",
  "internal_error"
]);

export const httpErrorDetailSchema = z.object({
  path: z.string().min(1),
  issue: z.string().min(1)
});

export const httpErrorEnvelopeSchema = z.object({
  error: z.object({
    code: httpErrorCodeSchema,
    message: z.string().min(1),
    details: z.array(httpErrorDetailSchema).optional()
  })
});

export type HttpErrorCode = z.infer<typeof httpErrorCodeSchema>;
export type HttpErrorDetail = z.infer<typeof httpErrorDetailSchema>;
export type HttpErrorEnvelope = z.infer<typeof httpErrorEnvelopeSchema>;
