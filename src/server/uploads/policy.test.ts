import { describe, expect, it } from "vitest";
import { MAX_FILE_SIZE, SIMPLE_UPLOAD_LIMIT, chooseUploadMode, validateDeclaredFile } from "./policy";

describe("上传策略", () => {
  it("20MB 及以下使用普通上传，超过后使用分片上传", () => {
    expect(chooseUploadMode(SIMPLE_UPLOAD_LIMIT)).toBe("simple");
    expect(chooseUploadMode(SIMPLE_UPLOAD_LIMIT + 1)).toBe("multipart");
  });

  it("拒绝超过 2GB 的文件", () => {
    expect(() => validateDeclaredFile({ name: "huge.mp4", type: "video/mp4", size: MAX_FILE_SIZE + 1 })).toThrow(
      "单文件不能超过 2GB",
    );
  });

  it("只接受 JPG、PNG 和 MP4", () => {
    expect(() => validateDeclaredFile({ name: "clip.webm", type: "video/webm", size: 1024 })).toThrow(
      "仅支持 JPG、PNG 和 MP4",
    );
  });
});
