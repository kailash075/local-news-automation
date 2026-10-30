import { describe, expect, it } from "vitest";
import { actionFor, backoffMs, classifyError } from "../../src/publishing/errors.ts";
import { evaluateGates, type GateInput } from "../../src/publishing/gates.ts";
import { createInstagramClient, redact, type InstagramClientError } from "../../src/publishing/instagram-client.ts";
import { formatIst, insideWindow, istMinuteOfDay, nextIstTime, startOfIstDay } from "../../src/publishing/ist.ts";
import { approval, fakeMeta, fixtures, IG_USER_ID, json, makeDraft, makeStory, networkError, NOON_IST, RENDER_SHA, TOKEN } from "./fakes.ts";

const client = (meta = fakeMeta()) => ({ meta, ig: createInstagramClient({ fetch: meta.fetch, accessToken: TOKEN, graphVersion: "v26.0" }) });

describe("Instagram client", () => {
  it("sends the token in a header and never in the URL", async () => {
    const { meta, ig } = client();
    await ig.createImageContainer({ igUserId: IG_USER_ID, imageUrl: "https://s.example/a.jpg", caption: "c", altText: "a" });
    await ig.getContainerStatus("1");
    await ig.publishContainer(IG_USER_ID, "1");
    await ig.getPermalink("2");
    await ig.getPublishingLimit(IG_USER_ID);
    await ig.listRecentMedia(IG_USER_ID);
    expect(meta.calls).toHaveLength(6);
    for (const call of meta.calls) {
      expect(call.url.startsWith("https://graph.instagram.com/v26.0/")).toBe(true);
      expect(call.url).not.toContain(TOKEN);
      expect(call.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    }
    expect(meta.writes().map((c) => c.endpoint)).toEqual(["create", "publish"]);
  });

  it("parses documented responses", async () => {
    const { ig } = client();
    expect(await ig.createImageContainer({ igUserId: IG_USER_ID, imageUrl: "https://s.example/a.jpg", caption: "c", altText: "a" })).toEqual({
      ok: true,
      value: { containerId: fixtures.createContainer.id },
    });
    expect(await ig.getContainerStatus("1")).toEqual({ ok: true, value: { status: "FINISHED" } });
    expect(await ig.getPublishingLimit(IG_USER_ID)).toEqual({ ok: true, value: { quotaUsage: 2, quotaTotal: 50, quotaDurationSeconds: 86400 } });
    expect(await ig.refreshToken()).toEqual({ ok: true, value: { accessToken: fixtures.refresh.access_token, expiresInSeconds: 5183944 } });
  });

  it("parses Meta's error envelope", async () => {
    const { meta, ig } = client();
    meta.handlers.publish = () => json(fixtures.errorSpam, 400);
    const r = await ig.publishContainer(IG_USER_ID, "1");
    expect(r).toEqual({
      ok: false,
      error: { kind: "api_error", httpStatus: 400, code: 4, subcode: 2207051, type: "OAuthException", isTransient: false, message: fixtures.errorSpam.error.message, fbtraceId: "AbCdEfGhIjK" },
    });
  });

  it("separates requests that were never sent from ambiguous ones", async () => {
    const { meta, ig } = client();
    meta.handlers.publish = () => {
      throw networkError("ECONNREFUSED");
    };
    expect(await ig.publishContainer(IG_USER_ID, "1")).toMatchObject({ ok: false, error: { kind: "not_sent" } });
    meta.handlers.publish = () => {
      throw networkError("ECONNRESET");
    };
    expect(await ig.publishContainer(IG_USER_ID, "1")).toMatchObject({ ok: false, error: { kind: "ambiguous" } });
    meta.handlers.publish = () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    expect(await ig.publishContainer(IG_USER_ID, "1")).toMatchObject({ ok: false, error: { kind: "ambiguous" } });
    meta.handlers.publish = () => new Response("<html>gateway</html>", { status: 502 });
    expect(await ig.publishContainer(IG_USER_ID, "1")).toMatchObject({ ok: false, error: { kind: "ambiguous", httpStatus: 502 } });
    meta.handlers.publish = () => new Response("not json", { status: 200 });
    expect(await ig.publishContainer(IG_USER_ID, "1")).toMatchObject({ ok: false, error: { kind: "ambiguous" } });
  });

  it("keeps the refresh URL's token out of errors", async () => {
    const { meta, ig } = client();
    meta.handlers.refresh = (call) => {
      throw new TypeError(`fetch failed: ${call.url}`);
    };
    const r = await ig.refreshToken();
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(meta.calls[0]?.headers["authorization"]).toBeUndefined();
  });

  it("redacts token-shaped strings", () => {
    expect(redact(`x access_token=${TOKEN}&y=1 Bearer abc.def`)).toBe("x access_token=[REDACTED]&y=1 Bearer [REDACTED]");
    expect(redact(`token ${TOKEN} here`)).not.toContain(TOKEN);
    expect(redact("short", ["abc"])).toBe("short");
  });
});

describe("error classification", () => {
  const api = (code: number | undefined, subcode: number | undefined, httpStatus = 400): InstagramClientError => ({
    kind: "api_error",
    httpStatus,
    message: "m",
    ...(code === undefined ? {} : { code }),
    ...(subcode === undefined ? {} : { subcode }),
  });

  it.each([
    [api(4, 2207051), "account_or_auth"],
    [api(25, 2207050), "account_or_auth"],
    [api(190, undefined, 401), "account_or_auth"],
    [api(200, undefined), "account_or_auth"],
    [api(9, 2207042), "quota"],
    [api(4, undefined), "quota"],
    [api(-1, 2207001, 500), "transient"],
    [api(-2, 2207003), "transient"],
    [api(24, 2207008), "transient"],
    [api(9007, 2207027), "transient"],
    [api(24, 2207006), "new_container"],
    [api(-2, 2207020), "new_container"],
    [api(-1, 2207032), "new_container"],
    [api(9004, 2207052), "fix_required"],
    [api(36000, 2207004), "fix_required"],
    [api(36003, 2207009), "fix_required"],
    [api(36004, 2207010), "fix_required"],
    [api(100, 2207040), "fix_required"],
    [api(100, undefined, 503), "transient"],
    [api(100, undefined), "unknown"],
    [{ kind: "not_sent", message: "m" }, "transient"],
    [{ kind: "ambiguous", message: "m" }, "ambiguous"],
  ] as const)("%j is %s", (e, expected) => {
    expect(classifyError(e)).toBe(expected);
  });

  it("maps classes to actions", () => {
    expect(actionFor("account_or_auth")).toBe("trip_kill_switch");
    expect(actionFor("ambiguous")).toBe("reconcile");
    expect(actionFor("unknown")).toBe("fail_and_alert");
    expect(backoffMs(1)).toBe(2 * 60_000);
    expect(backoffMs(9)).toBe(32 * 60_000);
  });
});

describe("IST helpers", () => {
  it("handles the +05:30 offset", () => {
    expect(istMinuteOfDay(NOON_IST)).toBe(12 * 60);
    expect(startOfIstDay(NOON_IST).toISOString()).toBe("2026-10-29T18:30:00.000Z");
    expect(formatIst(new Date("2026-10-30T15:29:00Z"))).toBe("20:59 IST");
    expect(insideWindow(new Date("2026-10-30T15:29:00Z"), { startMinute: 480, endMinute: 1260 })).toBe(true);
    expect(insideWindow(new Date("2026-10-30T15:30:00Z"), { startMinute: 480, endMinute: 1260 })).toBe(false);
    expect(nextIstTime(NOON_IST, 9, 0).toISOString()).toBe("2026-10-31T03:30:00.000Z");
  });
});

describe("gates", () => {
  const story = makeStory();
  const draft = makeDraft(story);
  const base: GateInput = {
    now: NOON_IST,
    switches: { databaseEnabled: true, repoVariableEnabled: true, dryRun: false },
    story,
    draft,
    currentDraft: draft,
    decisions: [approval(draft)],
    editors: [approval(draft).editorLogin],
    approvalTtlHours: 12,
    verificationLevel: "V2_OFFICIAL",
    validation: { passed: true, problems: [] },
    storedRenderSha256: RENDER_SHA,
    alreadyPublished: false,
    nearDuplicate: { found: false, overriddenByEditor: false },
    cadence: { window: { startMinute: 480, endMinute: 1260 }, maxPostsPerDay: 6, minMinutesBetweenPosts: 30, publishedToday: 0, lastPublishedAt: undefined },
    quota: { usage: 0, total: 50 },
    token: { present: true, expiresAt: new Date("2026-12-01T00:00:00Z") },
  };
  const codes = (input: GateInput): readonly string[] => {
    const r = evaluateGates(input);
    return r.pass ? [] : r.reasons.map((x) => x.code);
  };

  it("passes when everything holds", () => {
    expect(evaluateGates(base)).toEqual({ pass: true, mode: "publish" });
  });

  it("blocks on each gate", () => {
    expect(codes({ ...base, switches: { ...base.switches, databaseEnabled: false } })).toContain("kill_switch");
    expect(codes({ ...base, storedRenderSha256: undefined })).toContain("render_mismatch");
    expect(codes({ ...base, validation: { passed: false, problems: ["caption too long"] } })).toContain("validation");
    expect(codes({ ...base, alreadyPublished: true })).toContain("already_published");
    expect(codes({ ...base, nearDuplicate: { found: true, overriddenByEditor: false } })).toContain("near_duplicate");
    expect(codes({ ...base, nearDuplicate: { found: true, overriddenByEditor: true } })).toEqual([]);
    expect(codes({ ...base, cadence: { ...base.cadence, publishedToday: 6 } })).toContain("daily_cap");
    expect(codes({ ...base, cadence: { ...base.cadence, lastPublishedAt: new Date(NOON_IST.getTime() - 10 * 60_000) } })).toContain("spacing");
    expect(codes({ ...base, quota: undefined })).toContain("quota");
    expect(codes({ ...base, quota: { usage: 50, total: 50 } })).toContain("quota");
    expect(codes({ ...base, token: { present: false } })).toContain("token");
    expect(codes({ ...base, story: { ...story, status: "on_hold" } })).toContain("story_state");
    expect(codes({ ...base, decisions: [] })).toContain("no_approval");
    expect(codes({ ...base, editors: [] })).toContain("editor_not_allowed");
  });

  it("in dry run, operational gates become notes but approval gates still block", () => {
    const dry = { ...base, switches: { databaseEnabled: false, repoVariableEnabled: false, dryRun: true }, quota: undefined, token: { present: false } };
    const r = evaluateGates(dry);
    expect(r.pass && r.mode).toBe("would_publish");
    expect(codes({ ...dry, decisions: [] })).toContain("no_approval");
  });
});
