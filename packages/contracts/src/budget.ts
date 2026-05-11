import { z } from "zod";

export const budgetStatusSchema = z.enum(["within_budget", "near_limit", "exceeded", "unknown"]);

export const budgetSchema = z.object({
  status: budgetStatusSchema,
  maxCostUsd: z.number().nonnegative(),
  spentCostUsd: z.number().nonnegative()
});

export type Budget = z.infer<typeof budgetSchema>;
