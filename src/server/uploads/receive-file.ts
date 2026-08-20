import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileTypeFromFile } from "file-type";
import { isAllowedDetectedType, MAX_FILE_SIZE } from "./policy";

export async function receiveFile(
  request: Request,
  options: { directory: string; declaredSize: number; declaredType: string },
) {
  if (!request.body) throw new Error("请求中没有文件内容");
  if (!Number.isSafeInteger(options.declaredSize) || options.declaredSize <= 0) throw new Error("文件大小无效");
  if (options.declaredSize > MAX_FILE_SIZE) throw new Error("单文件不能超过 2GB");
  await mkdir(options.directory, { recursive: true });
  const filePath = join(options.directory, randomUUID());
  let received = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > options.declaredSize || received > MAX_FILE_SIZE) {
        callback(new Error("实际文件大小超过声明值"));
        return;
      }
      callback(null, chunk);
    },
  });

  const cleanup = () => rm(filePath, { force: true });
  try {
    await pipeline(Readable.fromWeb(request.body as never), counter, createWriteStream(filePath, { flags: "wx" }));
    if (received !== options.declaredSize) throw new Error("实际文件大小与声明值不一致");
    const detected = await fileTypeFromFile(filePath);
    if (!isAllowedDetectedType(detected?.mime) || detected?.mime !== options.declaredType) {
      throw new Error("文件内容与声明类型不匹配");
    }
    return { filePath, detectedType: detected.mime, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
