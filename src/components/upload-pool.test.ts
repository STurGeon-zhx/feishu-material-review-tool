import { describe, expect, it } from "vitest";
import { runStableUploadPool } from "./upload-pool";

const MB = 1024 * 1024;

function gate() {
  let release!: () => void;
  return {
    promise: new Promise<void>((resolve) => { release = resolve; }),
    release,
  };
}

describe("稳定上传任务池", () => {
  it("小文件最多同时处理 3 个", async () => {
    const blockers = Array.from({ length: 4 }, () => gate());
    let active = 0;
    let maximum = 0;
    const running = runStableUploadPool(
      blockers.map((_, index) => ({ id: index, file: { size: MB } })),
      async (item) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await blockers[item.id].promise;
        active -= 1;
      },
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(active).toBe(3);
    blockers.forEach((item) => item.release());
    await running;
    expect(maximum).toBe(3);
  });

  it("大文件最多同时处理 2 个，同时允许小文件占用第 3 个槽位", async () => {
    const blockers = Array.from({ length: 4 }, () => gate());
    let activeLarge = 0;
    let maximumLarge = 0;
    let activeTotal = 0;
    let maximumTotal = 0;
    const running = runStableUploadPool([
      { id: 0, file: { size: 21 * MB } },
      { id: 1, file: { size: 50 * MB } },
      { id: 2, file: { size: 200 * MB } },
      { id: 3, file: { size: MB } },
    ], async (item) => {
      const large = item.file.size > 20 * MB;
      activeTotal += 1;
      if (large) activeLarge += 1;
      maximumTotal = Math.max(maximumTotal, activeTotal);
      maximumLarge = Math.max(maximumLarge, activeLarge);
      await blockers[item.id].promise;
      activeTotal -= 1;
      if (large) activeLarge -= 1;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(activeTotal).toBe(3);
    expect(activeLarge).toBe(2);
    blockers.forEach((item) => item.release());
    await running;
    expect(maximumTotal).toBe(3);
    expect(maximumLarge).toBe(2);
  });

  it("单个任务失败不会取消其他上传", async () => {
    const completed: number[] = [];
    const results = await runStableUploadPool(
      [1, 2, 3].map((id) => ({ id, file: { size: MB } })),
      async ({ id }) => {
        if (id === 2) throw new Error("upload failed");
        completed.push(id);
      },
    );

    expect(completed.sort()).toEqual([1, 3]);
    expect(results.map((item) => item.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  });
});
