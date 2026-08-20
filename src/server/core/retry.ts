export interface RetryOptions {
  attempts?: number;
  delay?: (milliseconds: number) => Promise<void>;
}

function defaultDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function retryOperation<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3;
  const delay = options.delay ?? defaultDelay;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const retryable = typeof error === "object" && error !== null && "retryable" in error && error.retryable === true;
      if (!retryable || attempt === attempts) throw error;
      await delay(250 * 2 ** (attempt - 1));
    }
  }

  throw lastError;
}
