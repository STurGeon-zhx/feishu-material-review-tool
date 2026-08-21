import { describe, expect, it } from "vitest";
import { parseConfig } from "./config";

describe("parseConfig", () => {
  it("只使用应用身份所需的环境变量", () => {
    expect(parseConfig({
      FEISHU_APP_ID: "cli_test",
      FEISHU_APP_SECRET: "secret",
      DATABASE_URL: "file:./data/test.db",
    })).toEqual({
      appId: "cli_test",
      appSecret: "secret",
      databaseUrl: "file:./data/test.db",
    });
  });
});
