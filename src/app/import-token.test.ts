import { describe, expect, it } from "vitest";
import { fakeMeta, IG_USER_ID, json, memoryTokens, mutableClock, NOON_IST, TOKEN } from "../../test/publishing/fakes.ts";
import { freshSheet } from "../../test/support/sheet.ts";
import { GitHubLoginSchema } from "../domain/types.ts";
import { createInstagramClient } from "../publishing/instagram-client.ts";
import { toIso } from "../publishing/ist.ts";
import type { Result } from "../lib/result.ts";
import { INSTAGRAM_TOKEN_SECRET } from "../sheet/stores.ts";
import { importToken, type ImportDeps } from "./import-token.ts";

const owner = GitHubLoginSchema.parse("kailash075");
const request = { token: TOKEN, actor: "kailash075" };
const SIXTY_DAYS_LATER = "2026-12-29T06:30:00.000Z";

const refusal = (r: Result<unknown, string>): string => {
  if (r.ok) throw new Error("expected the import to be refused");
  return r.error;
};

const setup = (overrides: Partial<ImportDeps> = {}) => {
  const meta = fakeMeta();
  const deps: ImportDeps = {
    tokens: memoryTokens(undefined),
    clock: mutableClock(NOON_IST),
    createClient: (accessToken) => createInstagramClient({ fetch: meta.fetch, accessToken, graphVersion: "v26.0" }),
    username: "erodeglitz",
    owner,
    ...overrides,
  };
  return { meta, tokens: deps.tokens, deps };
};

describe("Instagram token import", () => {
  it("stores the token with the account's ID after read-only checks, valid for Meta's 60 days", async () => {
    const { meta, tokens, deps } = setup();
    expect(await importToken(deps, request)).toEqual({
      ok: true,
      value: { username: "erodeglitz", expiresAt: SIXTY_DAYS_LATER, quota: { quotaUsage: 2, quotaTotal: 50, quotaDurationSeconds: 86400 } },
    });
    expect(await tokens.getInstagram()).toEqual({ igUserId: IG_USER_ID, accessToken: TOKEN, obtainedAt: NOON_IST.toISOString(), expiresAt: SIXTY_DAYS_LATER });
    expect(meta.calls.map((c) => c.endpoint)).toEqual(["me", "limit"]);
    expect(meta.writes()).toEqual([]);
  });

  it("keeps the token encrypted in the bridge's Script properties, not in the Sheet", async () => {
    const t = await freshSheet({ start: NOON_IST });
    const { deps } = setup({ tokens: t.stores.tokens, clock: t.clock });
    expect((await importToken(deps, request)).ok).toBe(true);
    const raw = t.google.properties.get(`SECRET_${INSTAGRAM_TOKEN_SECRET}`) ?? "";
    expect(raw).not.toBe("");
    expect(raw).not.toContain(TOKEN);
    expect(await t.stores.tokens.getInstagram()).toMatchObject({ igUserId: IG_USER_ID, accessToken: TOKEN });
  });

  it("replaces a token imported earlier", async () => {
    const { tokens, deps } = setup({
      tokens: memoryTokens({
        igUserId: IG_USER_ID,
        accessToken: "IGAAoldtokenoldtokenoldtoken",
        obtainedAt: toIso(new Date("2026-08-01T00:00:00Z")),
        expiresAt: toIso(new Date("2026-09-30T00:00:00Z")),
      }),
    });
    expect((await importToken(deps, request)).ok).toBe(true);
    expect(await tokens.getInstagram()).toMatchObject({ accessToken: TOKEN, expiresAt: SIXTY_DAYS_LATER });
  });

  it("lets only the owner import, and asks Meta nothing otherwise", async () => {
    for (const [overrides, actor] of [[{}, "someone-else"], [{ owner: undefined }, "kailash075"]] as const) {
      const { meta, tokens, deps } = setup(overrides);
      expect(await importToken(deps, { ...request, actor })).toEqual({ ok: false, error: "Only the owner (OWNER_GITHUB_LOGIN) can import the Instagram token." });
      expect(meta.calls).toEqual([]);
      expect(await tokens.getInstagram()).toBeUndefined();
    }
  });

  it("refuses a value that is not one line of token text, without asking Meta", async () => {
    for (const token of ["IGAA token with spaces in it", `${TOKEN}\n${TOKEN}`, "IGAAshort"]) {
      const { meta, deps } = setup();
      expect(refusal(await importToken(deps, { ...request, token }))).toContain("does not look like a token");
      expect(meta.calls).toEqual([]);
    }
  });

  it("refuses a token Meta rejects, without repeating the token", async () => {
    const { meta, tokens, deps } = setup();
    meta.handlers.me = () => json({ error: { message: `Invalid OAuth access token - Cannot parse access token ${TOKEN}`, type: "OAuthException", code: 190 } }, 400);
    const r = await importToken(deps, request);
    expect(refusal(r)).toContain("Meta did not accept the token (HTTP 400 code 190/-");
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(await tokens.getInstagram()).toBeUndefined();

    const facebook = "EAAGfacebooktokenfacebooktokenfacebooktoken";
    const second = setup();
    second.meta.handlers.me = () => json({ error: { message: "Invalid OAuth access token - Cannot parse access token", type: "OAuthException", code: 190 } }, 400);
    expect(refusal(await importToken(second.deps, { ...request, token: facebook }))).toContain("This looks like a Facebook token");
  });

  it("refuses a token of another account without naming that account", async () => {
    const { meta, tokens, deps } = setup();
    meta.handlers.me = () => json({ data: [{ user_id: "17841499999999999", username: "someone.personal" }] });
    const r = await importToken(deps, request);
    expect(refusal(r)).toContain("another Instagram account, not @erodeglitz");
    expect(JSON.stringify(r)).not.toContain("someone.personal");
    expect(meta.count("limit")).toBe(0);
    expect(await tokens.getInstagram()).toBeUndefined();
  });

  it("refuses when the publishing quota cannot be read", async () => {
    const { meta, tokens, deps } = setup();
    meta.handlers.limit = () => json({ error: { message: "Application does not have permission for this action", type: "OAuthException", code: 10 } }, 403);
    expect(refusal(await importToken(deps, request))).toContain("The publishing quota could not be read (HTTP 403 code 10/-");
    expect(await tokens.getInstagram()).toBeUndefined();
  });

  it("stops when the saved token cannot be read back", async () => {
    const { deps } = setup({ tokens: { saveInstagram: () => Promise.resolve(), getInstagram: () => Promise.resolve(undefined) } });
    await expect(importToken(deps, request)).rejects.toThrow(/could not be read back/);
  });
});
