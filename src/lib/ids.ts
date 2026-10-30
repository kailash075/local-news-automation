import { randomBytes } from "node:crypto";

/**
 * UUIDv7 (RFC 9562): 48-bit Unix millisecond timestamp, version 7, variant 10, 74 random bits.
 * Time-ordered, so new rows land at the end of B-tree indexes.
 */
export const uuidv7 = (now: Date = new Date()): string => {
  const ms = now.getTime();
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > 0xffff_ffff_ffff) {
    throw new RangeError("uuidv7: timestamp out of range");
  }
  const bytes = randomBytes(16);
  let t = ms;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = t % 256;
    t = Math.floor(t / 256);
  }
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
