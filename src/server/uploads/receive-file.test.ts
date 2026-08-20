import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { receiveFile } from "./receive-file";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function directory(): string {
  const value = mkdtempSync(join(tmpdir(), "receive-file-test-"));
  directories.push(value);
  return value;
}

describe("流式接收文件", () => {
  it("有效 JPEG 写入临时目录并由调用方清理", async () => {
    const target = directory();
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, ...new Array(80).fill(0), 0xff, 0xd9]);
    const result = await receiveFile(new Request("http://localhost/upload", { method: "PUT", body: bytes }), {
      directory: target,
      declaredSize: bytes.length,
      declaredType: "image/jpeg",
    });

    expect(result.detectedType).toBe("image/jpeg");
    expect(readdirSync(target)).toHaveLength(1);
    await result.cleanup();
    expect(readdirSync(target)).toHaveLength(0);
  });

  it("扩展类型与真实内容不符时拒绝并清理临时文件", async () => {
    const target = directory();
    const bytes = new TextEncoder().encode("not an mp4");

    await expect(
      receiveFile(new Request("http://localhost/upload", { method: "PUT", body: bytes }), {
        directory: target,
        declaredSize: bytes.length,
        declaredType: "video/mp4",
      }),
    ).rejects.toThrow("文件内容与声明类型不匹配");
    expect(readdirSync(target)).toHaveLength(0);
  });
});
