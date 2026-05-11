import type { SwitchyardEvent } from "@switchyard/contracts";

export function formatSseEvent(event: SwitchyardEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
