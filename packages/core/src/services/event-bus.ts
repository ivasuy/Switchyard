import type { SwitchyardEvent } from "@switchyard/contracts";

export type EventSubscriber = (event: SwitchyardEvent) => void | Promise<void>;

export class EventBus {
  private readonly subscribers = new Set<EventSubscriber>();

  subscribe(subscriber: EventSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  async publish(event: SwitchyardEvent): Promise<void> {
    await Promise.all([...this.subscribers].map((subscriber) => subscriber(event)));
  }
}
