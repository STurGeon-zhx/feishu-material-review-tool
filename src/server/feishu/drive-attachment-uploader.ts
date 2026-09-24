import { open, readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { retryOperation } from "../core/retry";
import { chooseUploadMode } from "../uploads/policy";
import { FeishuHttpClient } from "./http-client";

type SpreadsheetMediaParentType = "sheet_image" | "sheet_file";

function parentTypeFor(mimeType: string): SpreadsheetMediaParentType {
  return mimeType.startsWith("image/") ? "sheet_image" : "sheet_file";
}

interface ExistingAttachmentState {
  fileToken: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export function requiresSpreadsheetReupload(asset: ExistingAttachmentState): boolean {
  return Boolean(asset.fileToken) && (
    asset.errorCode === "FILE_RELATION_MISSING"
    || asset.errorMessage?.includes("602134071") === true
  );
}

export class DriveAttachmentUploader {
  constructor(
    private readonly client: FeishuHttpClient,
    private readonly waitForRequest: () => Promise<void> = async () => undefined,
  ) {}

  private request<T>(operation: () => Promise<T>): Promise<T> {
    return retryOperation(async () => {
      await this.waitForRequest();
      return operation();
    });
  }

  async upload(
    filePath: string,
    originalName: string,
    spreadsheetToken: string,
    mimeType: string,
  ): Promise<string> {
    const fileSize = (await stat(filePath)).size;
    const parentType = parentTypeFor(mimeType);
    return chooseUploadMode(fileSize) === "simple"
      ? this.simpleUpload(filePath, originalName, fileSize, spreadsheetToken, parentType)
      : this.multipartUpload(filePath, originalName, fileSize, spreadsheetToken, parentType);
  }

  private async simpleUpload(
    filePath: string,
    originalName: string,
    fileSize: number,
    spreadsheetToken: string,
    parentType: SpreadsheetMediaParentType,
  ) {
    const fileName = originalName || basename(filePath);
    const form = new FormData();
    form.set("file_name", fileName);
    form.set("parent_type", parentType);
    form.set("parent_node", spreadsheetToken);
    form.set("size", String(fileSize));
    form.set("file", new Blob([await readFile(filePath)]), fileName);
    const data = await this.request(() =>
      this.client.json<{ file_token?: string }>("/open-apis/drive/v1/medias/upload_all", {
        method: "POST",
        body: form,
      }),
    );
    if (!data.file_token) throw new Error("飞书普通上传响应缺少 file_token");
    return data.file_token;
  }

  private async multipartUpload(
    filePath: string,
    originalName: string,
    fileSize: number,
    spreadsheetToken: string,
    parentType: SpreadsheetMediaParentType,
  ) {
    const fileName = originalName || basename(filePath);
    const prepared = await this.request(() =>
      this.client.json<{ upload_id?: string; block_size?: number; block_num?: number }>(
        "/open-apis/drive/v1/medias/upload_prepare",
        {
          method: "POST",
          body: JSON.stringify({
            file_name: fileName,
            parent_type: parentType,
            parent_node: spreadsheetToken,
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
        form.set("file", new Blob([buffer]), `${fileName}.part${sequence}`);
        await this.request(() =>
          this.client.json("/open-apis/drive/v1/medias/upload_part", {
            method: "POST",
            body: form,
          }),
        );
      }
    } finally {
      await handle.close();
    }

    const finished = await this.request(() =>
      this.client.json<{ file_token?: string }>("/open-apis/drive/v1/medias/upload_finish", {
        method: "POST",
        body: JSON.stringify({ upload_id: prepared.upload_id, block_num: prepared.block_num }),
      }),
    );
    if (!finished.file_token) throw new Error("飞书分片上传完成响应缺少 file_token");
    return finished.file_token;
  }
}
