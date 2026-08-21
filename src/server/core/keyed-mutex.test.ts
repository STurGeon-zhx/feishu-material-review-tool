import { describe, expect, it } from "vitest";
import { KeyedMutex } from "./keyed-mutex";

describe("KeyedMutex", () => {
  it("同一个 key 串行执行", async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const first = mutex.run("sheet-1", async () => {
      events.push("first:start");
      await gate;
      events.push("first:end");
    });
    const second = mutex.run("sheet-1", async () => {
      events.push("second:start");
      events.push("second:end");
    });
    await Promise.resolve();

    expect(events).toEqual(["first:start"]);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("不同 key 可以并行执行", async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const first = mutex.run("sheet-1", async () => {
      events.push("one");
      await gate;
    });
    const second = mutex.run("sheet-2", async () => {
      events.push("two");
      await gate;
    });
    await Promise.resolve();

    expect(events).toEqual(["one", "two"]);
    release();
    await Promise.all([first, second]);
  });
});
