import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, parseEncryptionKey } from "./crypto.ts";

const key = () => new Uint8Array(randomBytes(32));
const SECRET = "IGAAexampletoken0123456789abcdefghijklmnop";

describe("token encryption (AES-256-GCM)", () => {
  it("round-trips and never stores the plaintext", () => {
    const k = key();
    const enc = encryptSecret(k, SECRET, "newsroom.secrets:instagram_token", 3);
    expect(enc.iv).toHaveLength(12);
    expect(enc.authTag).toHaveLength(16);
    expect(enc.keyVersion).toBe(3);
    expect(Buffer.from(enc.ciphertext).toString("utf8")).not.toContain("IGAA");
    expect(decryptSecret(k, enc, "newsroom.secrets:instagram_token")).toBe(SECRET);
  });

  it("uses a fresh IV every time", () => {
    const k = key();
    const a = encryptSecret(k, SECRET, "aad");
    const b = encryptSecret(k, SECRET, "aad");
    expect(Buffer.from(a.iv).equals(Buffer.from(b.iv))).toBe(false);
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(false);
  });

  it("detects tampering with ciphertext, tag or associated data", () => {
    const k = key();
    const enc = encryptSecret(k, SECRET, "aad");
    const flipped = new Uint8Array(enc.ciphertext);
    flipped[0] = (flipped[0] ?? 0) ^ 0x01;
    expect(() => decryptSecret(k, { ...enc, ciphertext: flipped }, "aad")).toThrow(/wrong key or tampered/);
    const badTag = new Uint8Array(enc.authTag);
    badTag[5] = (badTag[5] ?? 0) ^ 0xff;
    expect(() => decryptSecret(k, { ...enc, authTag: badTag }, "aad")).toThrow(/wrong key or tampered/);
    expect(() => decryptSecret(k, enc, "other")).toThrow(/wrong key or tampered/);
  });

  it("fails with a wrong key without leaking the plaintext", () => {
    const enc = encryptSecret(key(), SECRET, "aad");
    let message = "";
    try {
      decryptSecret(key(), enc, "aad");
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/wrong key or tampered/);
    expect(message).not.toContain(SECRET);
  });

  it("parses only base64 keys of exactly 32 bytes", () => {
    const good = Buffer.from(randomBytes(32)).toString("base64");
    expect(parseEncryptionKey(`  ${good}\n`)).toHaveLength(32);
    expect(() => parseEncryptionKey(Buffer.from(randomBytes(16)).toString("base64"))).toThrow(/32 bytes, got 16/);
    expect(() => parseEncryptionKey("not base64 at all!")).toThrow(/not valid base64/);
    expect(() => encryptSecret(new Uint8Array(31), SECRET, "aad")).toThrow(/32 bytes/);
  });
});
