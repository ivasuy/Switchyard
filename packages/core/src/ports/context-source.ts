export interface ContextSource {
  loadContext(input: Record<string, unknown>): Promise<Record<string, unknown>>;
}
