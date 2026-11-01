import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { freshSheet, type TestSheet } from "../../test/support/sheet.ts";
import { iso, makeDraft, makePublication, makeStory } from "../../test/support/fixtures.ts";
import { createSheetStores, INSTAGRAM_TOKEN_SECRET } from "./stores.ts";
import { TABLES } from "./tables.ts";

const TOKEN = "IGAAQexampleLongLivedToken0123456789abcdefXYZ";

const credentials = (t: TestSheet) => ({
  api: "instagram_login" as const,
  igUserId: "17841400000000000",
  accessToken: TOKEN,
  obtainedAt: iso(t.clock.now()),
  expiresAt: iso(new Date(t.clock.now().getTime() + 60 * 86_400_000)),
});

const stored = (t: TestSheet): string => t.google.properties.get(`SECRET_${INSTAGRAM_TOKEN_SECRET}`) ?? "";

const everyCell = (t: TestSheet): string =>
  [...t.google.spreadsheet.sheets.values()].flatMap((s) => [...s.cells.values()].map((c) => String(c.value))).join("\n");

describe("token storage in the bridge's Script properties", () => {
  it("stores only ciphertext, with the expiry readable for alerts, and nothing in the Sheet", async () => {
    const t = await freshSheet();
    await t.stores.tokens.saveInstagram(credentials(t));
    const envelope = JSON.parse(stored(t)) as Record<string, unknown>;
    expect(stored(t)).not.toContain(TOKEN);
    expect(Buffer.from(String(envelope["ciphertext"]), "base64").toString("latin1")).not.toContain("IGAA");
    expect(envelope).toMatchObject({ keyVersion: 1, expiresAt: credentials(t).expiresAt });
    expect(everyCell(t)).not.toContain(TOKEN);
  });

  it("stores a Unified login token without an expiry date, because it does not expire", async () => {
    const t = await freshSheet();
    const unified = { api: "unified_login" as const, igUserId: "17841400000000000", accessToken: TOKEN, obtainedAt: iso(t.clock.now()) };
    await t.stores.tokens.saveInstagram(unified);
    const envelope = JSON.parse(stored(t)) as Record<string, unknown>;
    expect(envelope).not.toHaveProperty("expiresAt");
    expect(stored(t)).not.toContain(TOKEN);
    expect(await t.stores.tokens.getInstagram()).toEqual(unified);
  });

  it("detects a tampered value", async () => {
    const t = await freshSheet();
    await t.stores.tokens.saveInstagram(credentials(t));
    const envelope = JSON.parse(stored(t)) as { ciphertext: string };
    const bytes = Buffer.from(envelope.ciphertext, "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    t.google.properties.set(`SECRET_${INSTAGRAM_TOKEN_SECRET}`, JSON.stringify({ ...envelope, ciphertext: bytes.toString("base64") }));
    await expect(t.stores.tokens.getInstagram()).rejects.toThrow(/wrong key or tampered/);
  });

  it("cannot be read with another key", async () => {
    const t = await freshSheet();
    await t.stores.tokens.saveInstagram(credentials(t));
    const other = createSheetStores(t.bridge, { clock: t.clock, tokenKey: new Uint8Array(randomBytes(32)) });
    await expect(other.tokens.getInstagram()).rejects.toThrow(/wrong key or tampered/);
  });

  it("refuses to read or write without a key", async () => {
    const t = await freshSheet({ tokenKey: null });
    await expect(t.stores.tokens.saveInstagram(credentials(t))).rejects.toThrow(/TOKEN_ENCRYPTION_KEY is not configured/);
    await expect(t.stores.tokens.getInstagram()).rejects.toThrow(/TOKEN_ENCRYPTION_KEY is not configured/);
  });

  it("rejects malformed credentials before storing them", async () => {
    const t = await freshSheet();
    await expect(t.stores.tokens.saveInstagram({ ...credentials(t), igUserId: "not-a-number" })).rejects.toThrow();
    expect(stored(t)).toBe("");
  });

  it("redacts tokens from error rows and publish attempts", async () => {
    const t = await freshSheet();
    const run = await t.stores.jobRuns.start("publish", "1", "sha");
    await t.stores.jobRuns.recordError({
      jobRunId: run,
      stage: "publish",
      errorClass: "HttpError",
      message: `GET https://graph.instagram.com/v26.0/me?access_token=${TOKEN} failed; Authorization: Bearer ${TOKEN}`,
      retryable: true,
    });
    const story = makeStory(t.clock.now());
    await t.stores.stories.insert(story);
    const draft = makeDraft(story.id, t.clock.now());
    await t.stores.drafts.insert(draft);
    const pub = await t.stores.publications.createIfAbsent(makePublication(story.id, draft, t.clock.now()));
    await t.stores.publications.recordAttempt({
      publicationId: pub.id,
      step: "media_publish",
      outcome: "error",
      detail: `{"access_token":"${TOKEN}"}`,
      at: iso(t.clock.now()),
    });
    const [e] = await t.bridge.select(TABLES.errors.name);
    const [a] = await t.bridge.select(TABLES.publishAttempts.name);
    expect(e?.["message"]).toContain("access_token=[REDACTED]");
    expect(a?.["detail"]).not.toContain(TOKEN);
    expect(everyCell(t)).not.toContain(TOKEN);
  });
});
