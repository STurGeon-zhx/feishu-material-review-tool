import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

function decodeKey(encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY 必须是 32 字节 Base64 密钥");
  return key;
}

export function encryptSecret(plaintext: string, encodedKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, decodeKey(encodedKey), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), ciphertext.toString("base64url"), tag.toString("base64url")].join(".");
}

export function decryptSecret(payload: string, encodedKey: string): string {
  const [version, ivValue, ciphertextValue, tagValue] = payload.split(".");
  if (version !== "v1" || !ivValue || !ciphertextValue || !tagValue) throw new Error("令牌密文格式无效");
  const decipher = createDecipheriv(ALGORITHM, decodeKey(encodedKey), Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
