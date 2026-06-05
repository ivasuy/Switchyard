import type { SwitchyardEvent } from "@switchyard/contracts";
import type { EventBus } from "@switchyard/core";

const DEFAULT_TIMEOUT_MS = 50;
export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
export const SSE_IDLE_CLOSE_MS = 5 * 60 * 1000;

export function formatSseEvent(event: SwitchyardEvent): string {
  return `id: ${event.id}
event: ${event.type}
data: ${JSON.stringify(event)}

`;
}

export function formatSseHeartbeat(): string {
  return ":\n\n";
}

export function formatSseIdleClose(): string {
  return "event: stream.idle\ndata: {}\n\n";
}

function normalizeStopAfter(stopAfter: number, replayLength: number): number {
  if (!Number.isFinite(stopAfter) || stopAfter <= 0) {
    return replayLength;
  }
  return Math.max(1, Math.floor(stopAfter));
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
  startAfterEventId?: string;
}): Promise<string> {
  const replay = trimReplayByLastEventId(input.replay, input.startAfterEventId);
  const normalizedStopAfter = normalizeStopAfter(input.stopAfter, replay.length);
  const chunks = replay.slice(0, normalizedStopAfter).map(formatSseEvent);
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

function trimReplayByLastEventId(
  replay: SwitchyardEvent[],
  lastEventId: string | undefined
): SwitchyardEvent[] {
  if (!lastEventId) {
    return replay;
  }
  const index = replay.findIndex((event) => event.id === lastEventId);
  if (index < 0) {
    return replay;
  }
  return replay.slice(index + 1);
}

export interface SseWritable {
  write(chunk: string): boolean | void;
  end(): void;
  on(event: "close", listener: () => void): void;
}

export interface StreamRunEventsInput {
  runId: string;
  replay: SwitchyardEvent[];
  destination: SseWritable;
  live: boolean;
  stopAfter?: number | undefined;
  lastEventId?: string | undefined;
  eventBus?: EventBus | undefined;
  heartbeatIntervalMs?: number;
  idleTimeoutMs?: number;
  now?: () => number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface StreamRunEventsHandle {
  /** Resolves when the stream has finished writing and cleaned up. */
  finished: Promise<void>;
  /** Imperatively close the stream from the caller side. */
  close(): void;
}

export function streamRunEvents(input: StreamRunEventsInput): StreamRunEventsHandle {
  const heartbeatInterval = input.heartbeatIntervalMs ?? SSE_HEARTBEAT_INTERVAL_MS;
  const idleTimeout = input.idleTimeoutMs ?? SSE_IDLE_CLOSE_MS;
  const setIntervalFn = input.setIntervalFn ?? setInterval;
  const clearIntervalFn = input.clearIntervalFn ?? clearInterval;
  const setTimeoutFn = input.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = input.clearTimeoutFn ?? clearTimeout;

  const replay = trimReplayByLastEventId(input.replay, input.lastEventId);
  const stopAfter = input.stopAfter !== undefined
    ? normalizeStopAfter(input.stopAfter, replay.length + Number.MAX_SAFE_INTEGER)
    : undefined;

  let written = 0;
  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  let resolveFinished: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });

  const resetIdle = (): void => {
    if (idleTimer !== null) {
      clearTimeoutFn(idleTimer);
    }
    idleTimer = setTimeoutFn(() => {
      if (closed) {
        return;
      }
      try {
        input.destination.write(formatSseIdleClose());
      } catch {
        // best-effort
      }
      close();
    }, idleTimeout);
  };

  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    if (heartbeatTimer !== null) {
      clearIntervalFn(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (idleTimer !== null) {
      clearTimeoutFn(idleTimer);
      idleTimer = null;
    }
    try {
      input.destination.end();
    } catch {
      // best-effort
    }
    resolveFinished();
  };

  const writeEvent = (event: SwitchyardEvent): boolean => {
    if (closed) {
      return false;
    }
    try {
      input.destination.write(formatSseEvent(event));
    } catch {
      close();
      return false;
    }
    written += 1;
    if (stopAfter !== undefined && written >= stopAfter) {
      close();
      return false;
    }
    resetIdle();
    return true;
  };

  input.destination.on("close", () => {
    close();
  });

  for (const event of replay) {
    if (!writeEvent(event)) {
      return { finished, close };
    }
  }

  if (!input.live) {
    close();
    return { finished, close };
  }

  if (input.eventBus) {
    unsubscribe = input.eventBus.subscribe((event) => {
      if (event.runId !== input.runId) {
        return;
      }
      writeEvent(event);
    });
  }

  heartbeatTimer = setIntervalFn(() => {
    if (closed) {
      return;
    }
    try {
      input.destination.write(formatSseHeartbeat());
    } catch {
      close();
    }
  }, heartbeatInterval);

  resetIdle();

  return { finished, close };
}
