import { z } from "zod";
import { approvalIdSchema, isoDateSchema, runIdSchema, toolInvocationIdSchema } from "./ids.js";

export const toolTypeSchema = z.enum(["web_search", "fetch", "browser", "repo", "shell", "github", "fake_echo"]);
export const toolInvocationStatusSchema = z.enum(["queued", "running", "completed", "failed", "cancelled", "denied"]);

const nonEmptyTrimmedString = z.string().trim().min(1);
const absolutePathLikeSchema = z.string().trim().min(1).regex(/^([A-Za-z]:[\\/]|\/)/, "must be an absolute path");
const disallowControlCharacters = (value: string): boolean => !/[\u0000-\u001F\u007F]/.test(value);
const safeToolStringSchema = z.string().trim().min(1).max(1024).refine(disallowControlCharacters, "must not contain control characters");
const boundedPathspecSchema = z.string()
  .trim()
  .min(1)
  .max(512)
  .refine((value) => !value.startsWith("/") && !value.includes(".."), "must be a relative non-traversal path")
  .refine(disallowControlCharacters, "must not contain control characters");

export const fetchToolInputSchema = z.object({
  url: nonEmptyTrimmedString.url().max(4096),
  method: z.enum(["GET", "HEAD"]).default("GET"),
  captureContent: z.boolean().optional(),
  headers: z.record(nonEmptyTrimmedString, nonEmptyTrimmedString).optional()
}).strict();

export const webSearchToolInputSchema = z.object({
  query: nonEmptyTrimmedString.max(2048),
  maxResults: z.number().int().positive().max(50).optional()
}).strict();

export const githubToolOperationSchema = z.enum(["get_issue", "get_pull", "list_pull_files", "get_file", "compare_refs"]);

export const githubToolInputSchema = z.object({
  operation: githubToolOperationSchema,
  owner: nonEmptyTrimmedString.max(128),
  repo: nonEmptyTrimmedString.max(128),
  number: z.number().int().positive().optional(),
  ref: nonEmptyTrimmedString.max(256).optional(),
  base: nonEmptyTrimmedString.max(256).optional(),
  head: nonEmptyTrimmedString.max(256).optional(),
  path: nonEmptyTrimmedString.max(1024).optional()
}).strict().superRefine((input, ctx) => {
  if ((input.operation === "get_issue" || input.operation === "get_pull" || input.operation === "list_pull_files")
    && input.number === undefined) {
    ctx.addIssue({ code: "custom", path: ["number"], message: "number is required for this operation" });
  }
  if (input.operation === "get_file") {
    if (input.ref === undefined) {
      ctx.addIssue({ code: "custom", path: ["ref"], message: "ref is required for get_file" });
    }
    if (input.path === undefined) {
      ctx.addIssue({ code: "custom", path: ["path"], message: "path is required for get_file" });
    }
  }
  if (input.operation === "compare_refs") {
    if (input.base === undefined) {
      ctx.addIssue({ code: "custom", path: ["base"], message: "base is required for compare_refs" });
    }
    if (input.head === undefined) {
      ctx.addIssue({ code: "custom", path: ["head"], message: "head is required for compare_refs" });
    }
  }
});

export const repoToolOperationSchema = z.enum(["status", "diff", "show", "ls_files", "grep"]);

export const repoToolInputSchema = z.object({
  operation: repoToolOperationSchema,
  cwd: absolutePathLikeSchema,
  pathspec: z.array(boundedPathspecSchema).max(64).optional()
}).strict();

export const shellToolInputSchema = z.object({
  commandId: nonEmptyTrimmedString.max(128),
  args: z.array(safeToolStringSchema).max(32).optional(),
  cwd: absolutePathLikeSchema
}).strict();

export const browserToolInputSchema = z.object({
  action: nonEmptyTrimmedString.max(64).optional(),
  url: nonEmptyTrimmedString.url().max(4096).optional(),
  metadata: z.record(nonEmptyTrimmedString, z.unknown()).optional()
}).strict();

export const fakeEchoToolInputSchema = z.object({
  text: nonEmptyTrimmedString.max(8192).optional(),
  risk: z.enum(["safe", "risky", "destructive"]).optional(),
  requiresApproval: z.boolean().optional()
}).passthrough();

export const createToolInvocationRequestSchema = z.discriminatedUnion("type", [
  z.object({
    runId: runIdSchema.optional(),
    type: z.literal("fetch"),
    input: fetchToolInputSchema,
    approvalPolicy: nonEmptyTrimmedString.optional()
  }).strict(),
  z.object({
    runId: runIdSchema.optional(),
    type: z.literal("web_search"),
    input: webSearchToolInputSchema,
    approvalPolicy: nonEmptyTrimmedString.optional()
  }).strict(),
  z.object({
    runId: runIdSchema.optional(),
    type: z.literal("github"),
    input: githubToolInputSchema,
    approvalPolicy: nonEmptyTrimmedString.optional()
  }).strict(),
  z.object({
    runId: runIdSchema.optional(),
    type: z.literal("repo"),
    input: repoToolInputSchema,
    approvalPolicy: nonEmptyTrimmedString.optional()
  }).strict(),
  z.object({
    runId: runIdSchema.optional(),
    type: z.literal("shell"),
    input: shellToolInputSchema,
    approvalPolicy: nonEmptyTrimmedString.optional()
  }).strict(),
  z.object({
    runId: runIdSchema.optional(),
    type: z.literal("browser"),
    input: browserToolInputSchema,
    approvalPolicy: nonEmptyTrimmedString.optional()
  }).strict(),
  z.object({
    runId: runIdSchema.optional(),
    type: z.literal("fake_echo"),
    input: fakeEchoToolInputSchema,
    approvalPolicy: nonEmptyTrimmedString.optional()
  }).strict()
]);

export const toolInvocationSchema = z.object({
  id: toolInvocationIdSchema,
  runId: runIdSchema.optional(),
  type: toolTypeSchema,
  status: toolInvocationStatusSchema,
  approvalId: approvalIdSchema.optional(),
  input: z.record(z.string(), z.unknown()),
  output: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ code: z.string().min(1), message: z.string().min(1) }).optional(),
  createdAt: isoDateSchema,
  completedAt: isoDateSchema.optional()
});

export type ToolInvocation = z.infer<typeof toolInvocationSchema>;
