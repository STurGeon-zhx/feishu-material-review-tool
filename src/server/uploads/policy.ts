export const SIMPLE_UPLOAD_LIMIT = 20 * 1024 * 1024;
export const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "video/mp4"]);

export type UploadMode = "simple" | "multipart";

export function chooseUploadMode(size: number): UploadMode {
  return size <= SIMPLE_UPLOAD_LIMIT ? "simple" : "multipart";
}

export function validateDeclaredFile(file: { name: string; type: string; size: number }): void {
  if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new Error("文件大小无效");
  if (file.size > MAX_FILE_SIZE) throw new Error("单文件不能超过 2GB");
  if (!ALLOWED_TYPES.has(file.type)) throw new Error("仅支持 JPG、PNG 和 MP4");
}

export function isAllowedDetectedType(mime: string | undefined): boolean {
  return mime !== undefined && ALLOWED_TYPES.has(mime);
}
