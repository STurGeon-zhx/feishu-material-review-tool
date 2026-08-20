import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SIMPLE_UPLOAD_LIMIT } from "../uploads/policy";
import { FeishuHttpClient } from "./http-client";
import { FeishuUploader } from "./uploader";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function directory(): string {
  const value = mkdtempSync(join(tmpdir(), "feishu-upload-test-"));
  directories.push(value);
  return value;
}

function response(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, msg: "success", data }), {
    headers: { "content-type": "application/json" },
  });
}

describe("飞书附件上传", () => {
  it("小文件使用 upload_all 并绑定 bitable_file", async () => {
    const filePath = join(directory(), "demo.jpg");
    writeFileSync(filePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ file_token: "file-simple" }));
    const uploader = new FeishuUploader(new FeishuHttpClient("user-token", fetcher));

    const token = await uploader.upload(filePath, "demo.jpg", "app-token");

    expect(token).toBe("file-simple");
    expect(new URL(String(fetcher.mock.calls[0][0])).pathname).toBe("/open-apis/drive/v1/medias/upload_all");
    const form = fetcher.mock.calls[0][1]?.body as FormData;
    expect(form.get("parent_type")).toBe("bitable_file");
    expect(form.get("parent_node")).toBe("app-token");
  });

  it("大文件依次执行 prepare、part、finish", async () => {
    const filePath = join(directory(), "large.mp4");
    writeFileSync(filePath, Buffer.alloc(0));
    truncateSync(filePath, SIMPLE_UPLOAD_LIMIT + 1);
    const paths: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path.endsWith("upload_prepare")) {
        return response({ upload_id: "upload-1", block_size: 10 * 1024 * 1024, block_num: 3 });
      }
      if (path.endsWith("upload_finish")) return response({ file_token: "file-multipart" });
      return response({});
    });
    const uploader = new FeishuUploader(new FeishuHttpClient("user-token", fetcher));

    const token = await uploader.upload(filePath, "large.mp4", "app-token");

    expect(token).toBe("file-multipart");
    expect(paths).toEqual([
      "/open-apis/drive/v1/medias/upload_prepare",
      "/open-apis/drive/v1/medias/upload_part",
      "/open-apis/drive/v1/medias/upload_part",
      "/open-apis/drive/v1/medias/upload_part",
      "/open-apis/drive/v1/medias/upload_finish",
    ]);
  });
});
