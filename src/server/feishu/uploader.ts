import { open, readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { retryOperation } from "../core/retry";
import { chooseUploadMode } from "../uploads/policy";
import { FeishuHttpClient } from "./http-client";

export class FeishuUploader {
  constructor(private readonly client: FeishuHttpClient) {}

  async upload(filePath: string, originalName: string, appToken: string): Promise<string> {
    const fileSize = (await stat(filePath)).size;
    return chooseUploadMode(fileSize) === "simple"
      ? this.simpleUpload(filePath, originalName, fileSize, appToken)
      : this.multipartUpload(filePath, originalName, fileSize, appToken);
  }

  private async simpleUpload(filePath: string, originalName: string, fileSize: number, appToken: string) {
    const form = new FormData();
    form.set("file_name", originalName || basename(filePath));
    form.set("parent_type", "bitable_file");
    form.set("parent_node", appToken);
    form.set("size", String(fileSize));
    form.set("file", new Blob([await readFile(filePath)]), originalName);
    const data = await retryOperation(() =>
      this.client.json<{ file_token?: string }>("/open-apis/drive/v1/medias/upload_all", {
        method: "POST",
        body: form,
      }),
    );
    if (!data.file_token) throw new Error("飞书普通上传响应缺少 file_token");
    return data.file_token;
  }

  private async multipartUpload(filePath: string, originalName: string, fileSize: number, appToken: string) {
    const prepared = await retryOperation(() =>
      this.client.json<{ upload_id?: string; block_size?: number; block_num?: number }>(
        "/open-apis/drive/v1/medias/upload_prepare",
        {
          method: "POST",
          body: JSON.stringify({
            file_name: originalName || basename(filePath),
            parent_type: "bitable_file",
            parent_node: appToken,
            size: fileSize,
          }),
        },
      ),
    );
    if (!prepared.upload_id || !prepared.block_size || !prepared.block_num) {
      throw new Error("飞书分片预上传响应不完整");
    }

    const handle = await open(filePath, "r");
    try {
      for (let sequence = 0; sequence < prepared.block_num; sequence += 1) {
        const offset = sequence * prepared.block_size;
        const expectedSize = Math.min(prepared.block_size, fileSize - offset);
        const buffer = Buffer.allocUnsafe(expectedSize);
        const { bytesRead } = await handle.read(buffer, 0, expectedSize, offset);
        if (bytesRead !== expectedSize) throw new Error(`读取分片 ${sequence} 失败`);
        const form = new FormData();
        form.set("upload_id", prepared.upload_id);
        form.set("seq", String(sequence));
        form.set("size", String(bytesRead));
        form.set("file", new Blob([buffer]), `${originalName}.part${sequence}`);
        await retryOperation(() =>
          this.client.json("/open-apis/drive/v1/medias/upload_part", { method: "POST", body: form }),
        );
      }
    } finally {
      await handle.close();
    }

    const finished = await retryOperation(() =>
      this.client.json<{ file_token?: string }>("/open-apis/drive/v1/medias/upload_finish", {
        method: "POST",
        body: JSON.stringify({ upload_id: prepared.upload_id, block_num: prepared.block_num }),
      }),
    );
    if (!finished.file_token) throw new Error("飞书分片上传完成响应缺少 file_token");
    return finished.file_token;
  }
}
