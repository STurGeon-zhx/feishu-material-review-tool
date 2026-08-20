import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./token-crypto";

describe("令牌加密", () => {
  it("可解密由同一密钥加密的令牌", () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    const encrypted = encryptSecret("u-access-token", key);

    expect(decryptSecret(encrypted, key)).toBe("u-access-token");
    expect(encrypted).not.toContain("u-access-token");
  });

  it("密文被篡改时拒绝解密", () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    const encrypted = encryptSecret("u-access-token", key);
    const [version, iv, ciphertext, tagValue] = encrypted.split(".");
    const tag = Buffer.from(tagValue, "base64url");
    tag[0] ^= 1;
    const tampered = [version, iv, ciphertext, tag.toString("base64url")].join(".");

    expect(() => decryptSecret(tampered, key)).toThrow();
  });
});
