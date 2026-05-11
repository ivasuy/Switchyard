import type { SwitchyardEvent } from "@switchyard/contracts";
import type { EventBus } from "@switchyard/core";

export function formatSseEvent(event: SwitchyardEvent): string {
  return `id: ${event.id}
event: ${event.type}
data: ${JSON.stringify(event)}

`;
}

export async function collectReplayAndLiveEvents(input: {
  runId: string;
  replay: SwitchyardEvent[];
  eventBus: EventBus;
  stopAfter: number;
}): Promise<string> {
  const chunks = input.replay.map(formatSseEvent);
  if (chunks.length >= input.stopAfter) {
    return chunks.join("");
  }

  return new Promise((resolve) => {
    const unsubscribe = input.eventBus.subscribe((event) => {
      if (event.runId !== input.runId) {
        return;
      }
      chunks.push(formatSseEvent(event));
      if (chunks.length >= input.stopAfter) {
        unsubscribe();
        resolve(chunks.join(""));
      }
    });
  });
}
