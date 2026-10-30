import { describe, expect, it } from "vitest";
import { uuidv7 } from "./ids.ts";

describe("uuidv7", () => {
  it("produces RFC 9562 version 7 UUIDs with the timestamp in the first 48 bits", () => {
    const at = new Date("2026-10-30T04:30:00.123Z");
    const id = uuidv7(at);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const ms = Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);
    expect(ms).toBe(at.getTime());
  });

  it("sorts by creation time and does not repeat", () => {
    const a = uuidv7(new Date("2026-10-30T04:30:00.000Z"));
    const b = uuidv7(new Date("2026-10-30T04:30:00.001Z"));
    expect(a < b).toBe(true);
    const many = new Set(Array.from({ length: 1000 }, () => uuidv7()));
    expect(many.size).toBe(1000);
  });

  it("rejects timestamps outside the 48-bit range", () => {
    expect(() => uuidv7(new Date(-1))).toThrow(RangeError);
    expect(() => uuidv7(new Date(Number.NaN))).toThrow(RangeError);
  });
});
