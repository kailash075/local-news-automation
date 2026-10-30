import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** AES-256-GCM for secrets at rest. The key comes from the TOKEN_ENCRYPTION_KEY secret, never from the database. */

export const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type EncryptedSecret = {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  authTag: Uint8Array;
  keyVersion: number;
};

/** Decodes a base64 key and insists on exactly 32 bytes. The error never echoes the key. */
export const parseEncryptionKey = (base64: string): Uint8Array => {
  const trimmed = base64.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    throw new Error("TOKEN_ENCRYPTION_KEY is not valid base64");
  }
  const key = Buffer.from(trimmed, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(`TOKEN_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}`);
  }
  return new Uint8Array(key);
};

const assertKey = (key: Uint8Array): void => {
  if (key.length !== KEY_BYTES) {
    throw new Error(`encryption key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }
};

/**
 * `associatedData` binds the ciphertext to its purpose (for example the secret's name),
 * so a row copied under another name fails to decrypt.
 */
export const encryptSecret = (
  key: Uint8Array,
  plaintext: string,
  associatedData: string,
  keyVersion = 1,
): EncryptedSecret => {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(associatedData, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: new Uint8Array(ciphertext),
    iv: new Uint8Array(iv),
    authTag: new Uint8Array(cipher.getAuthTag()),
    keyVersion,
  };
};

/** Throws a generic error on a wrong key or tampered data; never includes plaintext or key material. */
export const decryptSecret = (key: Uint8Array, secret: EncryptedSecret, associatedData: string): string => {
  assertKey(key);
  if (secret.iv.length !== IV_BYTES || secret.authTag.length !== TAG_BYTES) {
    throw new Error("secret decryption failed: malformed iv or auth tag");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, secret.iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(associatedData, "utf8"));
    decipher.setAuthTag(secret.authTag);
    return Buffer.concat([decipher.update(secret.ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("secret decryption failed: wrong key or tampered data");
  }
};
