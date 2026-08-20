export class SingleFlight<T> {
  private readonly active = new Map<string, Promise<T>>();

  run(key: string, operation: () => Promise<T>): Promise<T> {
    const existing = this.active.get(key);
    if (existing) return existing;
    const promise = operation().finally(() => {
      if (this.active.get(key) === promise) this.active.delete(key);
    });
    this.active.set(key, promise);
    return promise;
  }
}
