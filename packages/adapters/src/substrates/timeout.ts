import { withTimeout } from "@switchyard/core";

export async function withAdapterTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return withTimeout(promise, timeoutMs, label);
}
