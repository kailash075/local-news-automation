import { describe, expect, it } from "vitest";
import { redact } from "./redact.ts";

describe("redact", () => {
  it("masks Instagram login and Graph API (system user) tokens", () => {
    expect(redact(`a IGAA${"x".repeat(40)} b`)).toBe("a [REDACTED] b");
    expect(redact(`a EAAG${"y".repeat(40)} b`)).toBe("a [REDACTED] b");
  });

  it("leaves ordinary words alone", () => {
    expect(redact("EAAGLE IGNORED")).toBe("EAAGLE IGNORED");
  });
});
