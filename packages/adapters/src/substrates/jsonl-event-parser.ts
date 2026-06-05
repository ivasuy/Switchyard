import type { SwitchyardEvent } from "@switchyard/contracts";

export interface JsonlEventParserOptions {
  runId: string;
  createdAt?: () => string;
  sanitizeError?: (message: string) => string;
  isTerminal?: (event: SwitchyardEvent) => boolean;
}

export async function* parseJsonlEvents<TRecord>(
  lines: AsyncIterable<string>,
  mapper: (record: TRecord, context: { runId: string; sequence: number; createdAt: string }) => SwitchyardEvent,
  options: JsonlEventParserOptions
): AsyncIterable<SwitchyardEvent> {
  let sequence = 0;
  const createdAt = options.createdAt ?? (() => new Date().toISOString());
  const isTerminal = options.isTerminal ?? ((event: SwitchyardEvent) => event.type === "run.completed" || event.type === "run.failed");

  for await (const line of lines) {
    if (line.length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as TRecord;
      const event = mapper(parsed, {
        runId: options.runId,
        sequence,
        createdAt: createdAt()
      });
      sequence += 1;
      yield event;
      if (isTerminal(event)) {
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const sanitized = options.sanitizeError ? options.sanitizeError(message) : message;
      yield {
        id: `event_${crypto.randomUUID()}`,
        type: "run.failed",
        runId: options.runId,
        sequence,
        payload: {
          status: "failed",
          error: sanitized
        },
        createdAt: createdAt()
      };
      return;
    }
  }
}
