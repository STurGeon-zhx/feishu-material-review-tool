import { describe, expect, it } from "vitest";
import { REQUIRED_CHECK_KEYS, calculateOverallStatus } from "./summary";

function passedChecks() {
  return REQUIRED_CHECK_KEYS.map((checkKey) => ({ checkKey, status: "pass" as const }));
}

describe("POC 总体验收状态", () => {
  it("匿名编辑失败但其他项通过时为部分通过", () => {
    const checks = passedChecks().map((check) =>
      check.checkKey === "anonymous_edit" ? { ...check, status: "fail" as const } : check,
    );
    expect(calculateOverallStatus(checks)).toBe("partial");
  });

  it("匿名查看失败时整体失败", () => {
    const checks = passedChecks().map((check) =>
      check.checkKey === "anonymous_view" ? { ...check, status: "fail" as const } : check,
    );
    expect(calculateOverallStatus(checks)).toBe("fail");
  });

  it("缺少真实证据时保持待验证", () => {
    expect(calculateOverallStatus([{ checkKey: "create_base", status: "pass" }])).toBe("pending");
  });

  it("全部通过时整体通过", () => {
    expect(calculateOverallStatus(passedChecks())).toBe("pass");
  });
});
