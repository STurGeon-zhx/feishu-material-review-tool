import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SIMPLE_UPLOAD_LIMIT } from "../uploads/policy";
import { DriveAttachmentUploader, requiresSpreadsheetReupload } from "./drive-attachment-uploader";
import { FeishuHttpClient } from "./http-client";

const directories: string[] = [];

afterEach(() => {
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

function directory(): string {
  const value = mkdtempSync(join(tmpdir(), "feishu-drive-upload-test-"));
  directories.push(value);
  return value;
}

function response(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, msg: "success", data }), {
    headers: { "content-type": "application/json" },
  });
}

describe("飞书电子表格附件上传", () => {
  it("小文件上传为目标电子表格的附件素材", async () => {
    const filePath = join(directory(), "demo.jpg");
    writeFileSync(filePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ file_token: "file-simple" }));
    const uploader = new DriveAttachmentUploader(new FeishuHttpClient("tenant-token", fetcher));

    const token = await uploader.upload(filePath, "demo.jpg", "spreadsheet-token", "image/jpeg");

    expect(token).toBe("file-simple");
    expect(new URL(String(fetcher.mock.calls[0][0])).pathname).toBe("/open-apis/drive/v1/medias/upload_all");
    const form = fetcher.mock.calls[0][1]?.body as FormData;
    expect(form.get("parent_type")).toBe("sheet_image");
    expect(form.get("parent_node")).toBe("spreadsheet-token");
  });

  it("图片选择附件模式时使用 sheet_file 上传点", async () => {
    const filePath = join(directory(), "attachment.png");
    writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ file_token: "file-image" }));
    const uploader = new DriveAttachmentUploader(new FeishuHttpClient("tenant-token", fetcher));

    await expect(uploader.upload(filePath, "attachment.png", "spreadsheet-token", "image/png", "attachment"))
      .resolves.toBe("file-image");
    const form = fetcher.mock.calls[0][1]?.body as FormData;
    expect(form.get("parent_type")).toBe("sheet_file");
  });

  it("每次飞书素材请求都先经过限速器", async () => {
    const filePath = join(directory(), "demo.jpg");
    writeFileSync(filePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const order: string[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      order.push("request");
      return response({ file_token: "file-simple" });
    });
    const uploader = new DriveAttachmentUploader(
      new FeishuHttpClient("tenant-token", fetcher),
      async () => { order.push("limit"); },
    );

    await uploader.upload(filePath, "demo.jpg", "spreadsheet-token", "image/jpeg");

    expect(order).toEqual(["limit", "request"]);
  });

  it("飞书请求重试时再次经过限速器", async () => {
    const filePath = join(directory(), "retry.jpg");
    writeFileSync(filePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const limiter = vi.fn(async () => undefined);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 1254291, msg: "busy" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(response({ file_token: "file-retried" }));
    const uploader = new DriveAttachmentUploader(new FeishuHttpClient("tenant-token", fetcher), limiter);

    await expect(uploader.upload(filePath, "retry.jpg", "spreadsheet-token", "image/jpeg"))
      .resolves.toBe("file-retried");
    expect(limiter).toHaveBeenCalledTimes(2);
  });

  it("大文件分片上传也关联到目标电子表格", async () => {
    const filePath = join(directory(), "large.mp4");
    writeFileSync(filePath, Buffer.alloc(0));
    truncateSync(filePath, SIMPLE_UPLOAD_LIMIT + 1);
    const paths: string[] = [];
    let prepareBody: Record<string, unknown> | undefined;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path.endsWith("upload_prepare")) {
        prepareBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return response({ upload_id: "upload-1", block_size: 10 * 1024 * 1024, block_num: 3 });
      }
      if (path.endsWith("upload_finish")) return response({ file_token: "file-multipart" });
      return response({});
    });
    const limiter = vi.fn(async () => undefined);
    const uploader = new DriveAttachmentUploader(new FeishuHttpClient("tenant-token", fetcher), limiter);

    const token = await uploader.upload(filePath, "large.mp4", "spreadsheet-token", "video/mp4");

    expect(token).toBe("file-multipart");
    expect(prepareBody).toMatchObject({
      file_name: "large.mp4",
      parent_type: "sheet_file",
      parent_node: "spreadsheet-token",
      size: SIMPLE_UPLOAD_LIMIT + 1,
    });
    expect(paths).toEqual([
      "/open-apis/drive/v1/medias/upload_prepare",
      "/open-apis/drive/v1/medias/upload_part",
      "/open-apis/drive/v1/medias/upload_part",
      "/open-apis/drive/v1/medias/upload_part",
      "/open-apis/drive/v1/medias/upload_finish",
    ]);
    expect(limiter).toHaveBeenCalledTimes(5);
  });

  it("缺少电子表格关联的旧 file_token 必须重新上传", () => {
    expect(requiresSpreadsheetReupload({
      fileToken: "legacy-token",
      errorCode: "SHEET_WRITE_FAILED",
      errorMessage: "[code=602134071] all file not has relation",
    })).toBe(true);
    expect(requiresSpreadsheetReupload({
      fileToken: "new-token",
      errorCode: "FILE_RELATION_MISSING",
      errorMessage: "all file not has relation",
    })).toBe(true);
    expect(requiresSpreadsheetReupload({
      fileToken: "related-token",
      errorCode: "SHEET_WRITE_FAILED",
      errorMessage: "temporary write failure",
    })).toBe(false);
  });
});
