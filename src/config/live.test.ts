import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { liveFileExists } from "./live.ts";

describe("LIVE file", () => {
  it("is live only while a file named LIVE exists in the root, even an empty one", () => {
    const dir = mkdtempSync(join(tmpdir(), "live-"));
    const root = pathToFileURL(`${dir}/`);
    expect(liveFileExists(root)).toBe(false);
    writeFileSync(join(dir, "LIVE"), "");
    expect(liveFileExists(root)).toBe(true);
  });
});
