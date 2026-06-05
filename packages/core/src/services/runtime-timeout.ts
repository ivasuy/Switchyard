export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label = "operation"): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(`${label} timeout`));
    }, timeoutMs);

    void promise.then(
      (value) => {
        if (timer) {
          clearTimeout(timer);
        }
        resolve(value);
      },
      (error) => {
        if (timer) {
          clearTimeout(timer);
        }
        reject(error);
      }
    );
  });
}

export function createAbortControllerWithTimeout(
  timeoutMs: number,
  label = "operation"
): { controller: AbortController; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new TimeoutError(`${label} timeout`));
  }, timeoutMs);
  return {
    controller,
    clear: () => {
      clearTimeout(timer);
    }
  };
}
