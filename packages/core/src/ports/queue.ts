export interface QueuePort<T = Record<string, unknown>> {
  enqueue(name: string, payload: T): Promise<{ id: string }>;
}
