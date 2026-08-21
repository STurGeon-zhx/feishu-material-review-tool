import { describe, expect, it } from "vitest";
import { chunkRecords, formatMaterialNumber } from "./batching";

describe("批量写入", () => {
  it("201 条记录拆成 200 和 1 两批", () => {
    const records = Array.from({ length: 201 }, (_, index) => index + 1);

    expect(chunkRecords(records)).toEqual([records.slice(0, 200), [201]]);
  });

  it("电子表格写入按 50 条拆批", () => {
    const records = Array.from({ length: 101 }, (_, index) => index + 1);

    expect(chunkRecords(records, 50)).toEqual([
      records.slice(0, 50),
      records.slice(50, 100),
      [101],
    ]);
  });

  it("素材编号至少补齐三位", () => {
    expect(formatMaterialNumber(1)).toBe("001");
    expect(formatMaterialNumber(1000)).toBe("1000");
  });
});
