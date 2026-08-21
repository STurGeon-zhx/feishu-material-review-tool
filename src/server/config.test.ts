import { describe, expect, it } from "vitest";
import { parseConfig } from "./config";

describe("parseConfig", () => {
  it("只读取数据库与本地凭证密钥路径", () => {
    expect(parseConfig({
      DATABASE_URL: "file:./data/test.db",
      CREDENTIAL_KEY_PATH: "./data/test.key",
    })).toEqual({
      databaseUrl: "file:./data/test.db",
      credentialKeyPath: "./data/test.key",
    });
  });
});
