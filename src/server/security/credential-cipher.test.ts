import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CredentialCipher, loadOrCreateCredentialKey } from "./credential-cipher";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("CredentialCipher", () => {
  it("首次生成 32 字节密钥并在后续启动复用", () => {
    const directory = mkdtempSync(join(tmpdir(), "feishu-review-key-"));
    directories.push(directory);
    const filename = join(directory, "credentials.key");
    const first = loadOrCreateCredentialKey(filename);
    const second = loadOrCreateCredentialKey(filename);
    expect(first).toHaveLength(32);
    expect(second.equals(first)).toBe(true);
    expect(readFileSync(filename).equals(first)).toBe(true);
  });

  it("使用 AES-256-GCM 加解密且不在密文中泄漏 Secret", () => {
    const cipher = new CredentialCipher(Buffer.alloc(32, 7));
    const encrypted = cipher.encrypt("very-sensitive-secret");
    expect(encrypted).not.toContain("very-sensitive-secret");
    expect(cipher.decrypt(encrypted)).toBe("very-sensitive-secret");
    expect(() => new CredentialCipher(Buffer.alloc(31))).toThrow(/32/);
  });
});
