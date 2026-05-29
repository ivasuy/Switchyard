export class AsyncLineQueue {
  private readonly items: string[] = [];
  private readonly waiters: Array<(value: IteratorResult<string>) => void> = [];
  private closed = false;

  push(line: string): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: line, done: false });
      return;
    }
    this.items.push(line);
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({ value: undefined, done: true });
    }
  }

  next(): Promise<IteratorResult<string>> {
    const item = this.items.shift();
    if (item !== undefined) {
      return Promise.resolve({ value: item, done: false });
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: () => this.next()
    };
  }
}
