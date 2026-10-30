import { describe, expect, it } from "vitest";
import { redact, registerSecret } from "./logger.ts";

describe("redact", () => {
  it("masks secret keys at any depth", () => {
    expect(redact({ a: { access_token: "abc", Authorization: "Bearer x", ok: 1 } })).toEqual({
      a: { access_token: "[REDACTED]", Authorization: "[REDACTED]", ok: 1 },
    });
  });
  it("masks registered secret values inside strings and errors", () => {
    registerSecret("IGQWRtoken123456");
    expect(redact("failed with IGQWRtoken123456 in body")).toBe("failed with [REDACTED] in body");
    expect(redact(new Error("x IGQWRtoken123456"))).toEqual({ name: "Error", message: "x [REDACTED]" });
  });
  it("masks access_token in URLs", () => {
    expect(redact("GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=zzz")).toBe(
      "GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=[REDACTED]",
    );
  });
});
