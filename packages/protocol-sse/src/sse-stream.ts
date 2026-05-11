import type { SwitchyardEvent } from "@switchyard/contracts";
import type { EventBus } from "@switchyard/core";

const DEFAULT_TIMEOUT_MS = 50;

export function formatSseEvent(event: SwitchyardEvent): string {
  return `id: ${event.id}
event: ${event.type}
data: ${JSON.stringify(event)}

`;
}

function normalizeStopAfter(stopAfter: number, replayLength: number): number {
  if (!Number.isFinite(stopAfter) || stopAfter <= 0) {
    return replayLength;
  }
  return Math.floor(stopAfter);
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return timeoutMs;
}

export async function collectReplayAndLiveEvents(input: {
  runId: string;
  replay: SwitchyardEvent[];
  eventBus: EventBus;
  stopAfter: number;
  timeoutMs?: number;
}): Promise<string> {
  const normalizedStopAfter = normalizeStopAfter(input.stopAfter, input.replay.length);
  const chunks = input.replay
    .slice(0, normalizedStopAfter)
    .map(formatSseEvent);
  if (chunks.length >= normalizedStopAfter) {
    return chunks.join("");
  }
  const timeoutMs = normalizeTimeoutMs(input.timeoutMs);
  let settled = false;
  let unsubscribe: (() => void) | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const resolve = (result: string, complete: (value: string) => void): void => {
    if (settled) {
      return;
    }
    settled = true;
    if (timeout !== null) {
      clearTimeout(timeout);
      timeout = null;
    }
    if (unsubscribe !== null) {
      unsubscribe();
      unsubscribe = null;
    }
    complete(result);
  };

  return new Promise((complete) => {
    timeout = setTimeout(() => {
      resolve(chunks.join(""), complete);
    }, timeoutMs);

    unsubscribe = input.eventBus.subscribe((event) => {
      if (event.runId !== input.runId) {
        return;
      }
      chunks.push(formatSseEvent(event));
      if (chunks.length >= normalizedStopAfter) {
        resolve(chunks.join(""), complete);
      }
    });
  });
}
