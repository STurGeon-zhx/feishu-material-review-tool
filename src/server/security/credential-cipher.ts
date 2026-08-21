import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const KEY_BYTES = 32;
const IV_BYTES = 12;

export function loadOrCreateCredentialKey(filename: string): Buffer {
  mkdirSync(dirname(filename), { recursive: true });
  try {
    const existing = readFileSync(filename);
    if (existing.length !== KEY_BYTES) throw new Error("本地凭证密钥长度无效");
    return existing;
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code !== "ENOENT") throw error;
  }

  const created = randomBytes(KEY_BYTES);
  try {
    writeFileSync(filename, created, { flag: "wx", mode: 0o600 });
    return created;
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "EEXIST") {
      const existing = readFileSync(filename);
      if (existing.length !== KEY_BYTES) throw new Error("本地凭证密钥长度无效");
      return existing;
    }
    throw error;
  }
}

export class CredentialCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== KEY_BYTES) throw new Error("凭证加密密钥必须为 32 字节");
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv, tag, ciphertext].map((part) => part.toString("base64url")).join(".");
  }

  decrypt(value: string): string {
    const [ivValue, tagValue, ciphertextValue, extra] = value.split(".");
    if (!ivValue || !tagValue || !ciphertextValue || extra) throw new Error("已保存的飞书凭证格式无效");
    const iv = Buffer.from(ivValue, "base64url");
    const tag = Buffer.from(tagValue, "base64url");
    const ciphertext = Buffer.from(ciphertextValue, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }
}
