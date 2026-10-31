import { describe, expect, it } from "vitest";
import { GitHubLoginSchema, StoryIdSchema } from "../../src/domain/types.ts";
import { toIso } from "../../src/publishing/ist.ts";
import { authorise, isApprovalExpired, type CommandContext } from "../../src/review/authorise.ts";
import { MAX_COMMENT_CHARS, parseCommand, type ReviewCommand } from "../../src/review/commands.ts";
import { parseStoryMarker, renderIssueBody, renderIssueTitle, storyMarker } from "../../src/review/issue-body.ts";
import { canonicalJson, revisionHash, shortHash } from "../../src/review/revision-hash.ts";
import { EDITOR, makeDraft, makeStory, NOON_IST, withoutRender } from "./fakes.ts";

const parsed = (body: string): ReviewCommand => {
  const r = parseCommand(body);
  if (!r.ok) throw new Error(`expected a command, got ${JSON.stringify(r.error)}`);
  return r.value;
};

describe("parseCommand", () => {
  it("parses approvals with a 12-character revision", () => {
    expect(parsed("/approve A1B2C3D4E5F6")).toEqual({ kind: "approve", rev: "a1b2c3d4e5f6" });
    expect(parsed("  /approve-sensitive a1b2c3d4e5f6  \n")).toEqual({ kind: "approve_sensitive", rev: "a1b2c3d4e5f6" });
    expect(parseCommand("/approve a1b2c3").ok).toBe(false);
    expect(parseCommand("/approve a1b2c3d4e5f6 looks good").ok).toBe(false);
  });

  it("parses schedule times in 24-hour IST", () => {
    expect(parsed("/schedule a1b2c3d4e5f6 18:30")).toEqual({ kind: "schedule", rev: "a1b2c3d4e5f6", time: { hour: 18, minute: 30 } });
    expect(parseCommand("/schedule a1b2c3d4e5f6 6:30pm").ok).toBe(false);
    expect(parseCommand("/schedule a1b2c3d4e5f6 24:00").ok).toBe(false);
  });

  it("keeps multi-line captions and rejects multi-line headlines", () => {
    expect(parsed("/caption முதல் வரி\nஇரண்டாம் வரி\r\n\r\nதகவல்: மின்வாரியம்")).toEqual({
      kind: "caption",
      text: "முதல் வரி\nஇரண்டாம் வரி\n\nதகவல்: மின்வாரியம்",
    });
    expect(parseCommand("/headline first\nsecond").ok).toBe(false);
    expect(parsed("/headline ஈரோட்டில் மின் தடை")).toEqual({ kind: "headline", text: "ஈரோட்டில் மின் தடை" });
  });

  it("needs reasons and attestation details", () => {
    expect(parseCommand("/hold").ok).toBe(false);
    expect(parsed("/hold waiting for police confirmation")).toEqual({ kind: "hold", reason: "waiting for police confirmation" });
    expect(parseCommand("/attest ok").ok).toBe(false);
    expect(parsed("/attest Called Erode Town police station at 10:40 IST")).toMatchObject({ kind: "attest" });
    expect(parsed("/unhold")).toEqual({ kind: "unhold" });
    expect(parseCommand("/unhold now").ok).toBe(false);
  });

  it("parses the kill switch", () => {
    expect(parsed("/killswitch on wrong death toll in last post")).toEqual({ kind: "killswitch_on", reason: "wrong death toll in last post" });
    expect(parsed("/killswitch off")).toEqual({ kind: "killswitch_off" });
    expect(parseCommand("/killswitch on").ok).toBe(false);
    expect(parseCommand("/killswitch maybe").ok).toBe(false);
  });

  it("treats the body as untrusted", () => {
    expect(parseCommand("Looks good to me /approve a1b2c3d4e5f6")).toEqual({ ok: false, error: { kind: "not_a_command" } });
    expect(parseCommand("/deploy now")).toEqual({ ok: false, error: { kind: "unknown_command", name: "deploy" } });
    expect(parseCommand(`/caption ${"அ".repeat(MAX_COMMENT_CHARS)}`)).toEqual({ ok: false, error: { kind: "too_long", maxChars: MAX_COMMENT_CHARS } });
    expect(parsed("/hold bad\u0000 data\u0007 here")).toEqual({ kind: "hold", reason: "bad data here" });
    expect(parsed("/caption $(rm -rf /) `id`")).toEqual({ kind: "caption", text: "$(rm -rf /) `id`" });
  });
});

describe("revision hash", () => {
  const story = makeStory();
  const draft = makeDraft(story);

  it("is deterministic and independent of key order", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: null, c: "x" }] })).toBe('{"a":[2,{"c":"x","d":null}],"b":1}');
    expect(makeDraft(story, { id: draft.id }).revisionHash).toBe(draft.revisionHash);
  });

  it("changes whenever approved content changes", () => {
    expect(makeDraft(story, { captionTa: `${draft.captionTa}.` }).revisionHash).not.toBe(draft.revisionHash);
    expect(makeDraft(story, { hashtags: ["#Erode"] }).revisionHash).not.toBe(draft.revisionHash);
    const base = {
      storyId: story.id,
      revision: 1,
      headlineTa: "h",
      captionTa: "c",
      hashtags: [],
      altText: "a",
      sourceCreditTa: "s",
      templateVersion: "t",
      sources: [{ name: "n", url: "https://example.org/1" }],
    };
    expect(revisionHash(base)).not.toBe(revisionHash({ ...base, sources: [{ name: "n", url: "https://example.org/2" }] }));
    expect(shortHash(draft.revisionHash)).toHaveLength(12);
  });
});

describe("authorise", () => {
  const ctx = (overrides: Partial<CommandContext> = {}): CommandContext => {
    const story = overrides.story ?? makeStory({ status: "in_review" });
    return {
      commenterLogin: "kailash075",
      authorAssociation: "OWNER",
      editors: [EDITOR],
      ownerLogin: EDITOR,
      story,
      currentDraft: makeDraft(story),
      verificationLevel: "V2_OFFICIAL",
      postingWindow: { startMinute: 8 * 60, endMinute: 21 * 60 },
      approvalTtlHours: 12,
      now: NOON_IST,
      ...overrides,
    };
  };
  const approveCurrent = (c: CommandContext, kind: "approve" | "approve_sensitive" = "approve"): ReviewCommand => ({
    kind,
    rev: c.currentDraft === undefined ? "000000000000" : shortHash(c.currentDraft.revisionHash),
  });

  it("approves the current revision of a routine story", () => {
    const c = ctx();
    const r = authorise(approveCurrent(c), c);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.revisionHash).toBe(c.currentDraft?.revisionHash);
      expect(r.value.storyEvent).toBe("approve");
    }
  });

  it("ignores commenters outside the allowlist without replying", () => {
    const c = ctx({ commenterLogin: "stranger" });
    expect(authorise(approveCurrent(c), c)).toMatchObject({ ok: false, error: { kind: "not_editor", reply: false } });
    const notCollaborator = ctx({ authorAssociation: "NONE" });
    expect(authorise(approveCurrent(notCollaborator), notCollaborator)).toMatchObject({ ok: false, error: { kind: "not_editor" } });
  });

  it("refuses plain /approve for R2 and disputed stories", () => {
    const r2 = ctx({ story: makeStory({ status: "in_review", riskTier: "R2_SENSITIVE" }) });
    expect(authorise(approveCurrent(r2), r2)).toMatchObject({ ok: false, error: { kind: "needs_sensitive_approval", reply: true } });
    expect(authorise(approveCurrent(r2, "approve_sensitive"), r2).ok).toBe(true);

    const disputed = ctx({ story: makeStory({ status: "in_review", disputed: true }), verificationLevel: "V3_EDITOR_ATTESTED" });
    expect(authorise(approveCurrent(disputed), disputed)).toMatchObject({ ok: false, error: { kind: "needs_sensitive_approval" } });
  });

  it("refuses to approve a V0 story until an editor attests", () => {
    const v0 = ctx({ verificationLevel: "V0_UNVERIFIED" });
    const r = authorise(approveCurrent(v0), v0);
    expect(r).toMatchObject({ ok: false, error: { kind: "insufficient_verification" } });
    if (!r.ok) expect(r.error.message).toContain("/attest");
    const attested = ctx({ verificationLevel: "V3_EDITOR_ATTESTED" });
    expect(authorise(approveCurrent(attested), attested).ok).toBe(true);
  });

  it("refuses a stale revision and names the current one", () => {
    const c = ctx();
    const r = authorise({ kind: "approve", rev: "0123456789ab" }, c);
    expect(r).toMatchObject({ ok: false, error: { kind: "stale_revision" } });
    if (!r.ok && c.currentDraft !== undefined) expect(r.error.message).toContain(shortHash(c.currentDraft.revisionHash));
  });

  it("refuses approval before the graphic is rendered", () => {
    const story = makeStory({ status: "in_review" });
    const c = ctx({ story, currentDraft: withoutRender(makeDraft(story)) });
    expect(authorise(approveCurrent(c), c)).toMatchObject({ ok: false, error: { kind: "not_rendered" } });
  });

  it("lets any editor stop publishing but only the owner restart it", () => {
    const second = GitHubLoginSchema.parse("second-editor");
    const c = ctx({ commenterLogin: "second-editor", editors: [EDITOR, second], authorAssociation: "COLLABORATOR" });
    expect(authorise({ kind: "killswitch_on", reason: "bad post" }, c).ok).toBe(true);
    expect(authorise({ kind: "killswitch_off" }, c)).toMatchObject({ ok: false, error: { kind: "owner_only" } });
    expect(authorise({ kind: "killswitch_off" }, ctx()).ok).toBe(true);
    // Without a configured owner nobody can switch publishing back on from an issue (fail closed).
    const withoutOwner = ctx();
    delete withoutOwner.ownerLogin;
    expect(authorise({ kind: "killswitch_off" }, withoutOwner)).toMatchObject({ ok: false, error: { kind: "owner_only" } });
  });

  it("schedules inside the window and within the approval lifetime", () => {
    const c = ctx();
    const rev = shortHash(c.currentDraft?.revisionHash ?? makeDraft(c.story).revisionHash);
    const ok = authorise({ kind: "schedule", rev, time: { hour: 18, minute: 30 } }, c);
    expect(ok).toMatchObject({ ok: true, value: { scheduledFor: "2026-10-30T13:00:00.000Z", storyEvent: "approve" } });
    expect(authorise({ kind: "schedule", rev, time: { hour: 22, minute: 0 } }, c)).toMatchObject({ ok: false, error: { kind: "invalid_schedule" } });
    // 09:00 IST has passed at noon, so it means tomorrow: 21 hours away, beyond the 12-hour approval lifetime.
    expect(authorise({ kind: "schedule", rev, time: { hour: 9, minute: 0 } }, c)).toMatchObject({ ok: false, error: { kind: "invalid_schedule" } });
    const r2 = ctx({ story: makeStory({ status: "in_review", riskTier: "R2_SENSITIVE" }) });
    expect(authorise({ kind: "schedule", rev: shortHash(r2.currentDraft?.revisionHash ?? makeDraft(r2.story).revisionHash), time: { hour: 18, minute: 0 } }, r2)).toMatchObject({
      ok: false,
      error: { kind: "needs_sensitive_approval" },
    });
  });

  it("checks the story state", () => {
    const published = ctx({ story: makeStory({ status: "published" }) });
    expect(authorise(approveCurrent(published), published)).toMatchObject({ ok: false, error: { kind: "wrong_state" } });
    expect(authorise({ kind: "retract", reason: "wrong facts" }, published).ok).toBe(true);
    expect(authorise({ kind: "attest", method: "Called the collector's office" }, published)).toMatchObject({ ok: false, error: { kind: "wrong_state" } });
  });

  it("expires approvals after the TTL", () => {
    expect(isApprovalExpired({ createdAt: toIso(new Date("2026-10-30T00:00:00Z")) }, NOON_IST, 12)).toBe(false);
    expect(isApprovalExpired({ createdAt: toIso(new Date("2026-10-29T18:00:00Z")) }, NOON_IST, 12)).toBe(true);
  });
});

describe("issue body", () => {
  it("starts with the story marker and parses it back", () => {
    const story = makeStory({ status: "in_review" });
    const body = renderIssueBody({ story, draft: makeDraft(story), verificationLevel: "V2_OFFICIAL", sources: [], checks: [], possibleDuplicates: [] });
    expect(body.split("\n")[0]).toBe(storyMarker(story.id));
    expect(parseStoryMarker(body)).toBe(story.id);
  });

  it("ignores markers anywhere but the first line", () => {
    const story = makeStory();
    const other = makeStory();
    const body = renderIssueBody({
      story,
      draft: makeDraft(story, { captionTa: `${storyMarker(other.id)} @someone`, headlineTa: "@headline <b>" }),
      verificationLevel: "V1_CORROBORATED",
      sources: [
        {
          name: "<!-- erodeglitz:story=x --> @mention",
          url: "https://example.org/a b",
          trustTier: "T2_established_publisher",
          relation: "primary",
        },
      ],
      checks: ["Caption 80/1800 characters"],
      possibleDuplicates: [],
    });
    expect(parseStoryMarker(body)).toBe(story.id);
    expect(parseStoryMarker(`intro\n${storyMarker(other.id)}`)).toBeUndefined();
    expect(body).not.toContain("@someone");
    expect(body).not.toContain("@mention");
    expect(body).not.toContain("@headline");
    expect(body).not.toContain("<b>");
    expect(body).toContain("https://example.org/a%20b");
    expect(body.match(/<!-- erodeglitz:story=/g)).toHaveLength(1);
  });

  it("lists each source by name and link, never its headline (the issue is public)", () => {
    const story = makeStory();
    const body = renderIssueBody({
      story,
      verificationLevel: "V0_UNVERIFIED",
      sources: [
        {
          name: "Dinakaran, Erode district",
          url: "https://www.dinakaran.com/district/erode_301026_3",
          trustTier: "T2_established_publisher",
          relation: "primary",
          publishedAt: toIso(new Date("2026-10-30T01:03:34.000Z")),
        },
      ],
      checks: [],
      possibleDuplicates: [],
    });
    expect(body).toContain(
      "1. Dinakaran, Erode district, <https://www.dinakaran.com/district/erode_301026_3>, published 06:33 IST 2026-10-30, tier T2_established_publisher, primary",
    );
  });

  it("titles: the editor's headline, else our own label, never the same text for every story of a run", () => {
    // Two real story ids from one run: UUIDv7, so their first eight characters (the creation time) are equal.
    const story = makeStory({ topic: "business", id: StoryIdSchema.parse("01a18dfb-0c1b-721f-8012-c1f39a5596ab") });
    const twin = makeStory({ topic: "business", id: StoryIdSchema.parse("01a18dfb-0c1b-7325-a023-8d8913b72d06") });
    expect(renderIssueTitle(story, makeDraft(story))).toBe(makeDraft(story).headlineTa);
    expect(renderIssueTitle(story, undefined, "  பெருந்துறை ·\n தினமணி ")).toBe(`பெருந்துறை · தினமணி · business · ${story.id.slice(-8)}`);
    // Regression (first real draft run, 2026-10-30): ten issues were all titled "business story 01a18dfb".
    expect(renderIssueTitle(story, undefined)).not.toBe(renderIssueTitle(twin, undefined));
    expect(renderIssueTitle(story, undefined, "@someone said")).not.toContain("@someone");
    const sensitive = makeStory({ riskTier: "R2_SENSITIVE" });
    expect(renderIssueTitle(sensitive, undefined, "கொடுமுடி")).toBe(`[R2] கொடுமுடி · ${sensitive.topic} · ${sensitive.id.slice(-8)}`);
  });

  it("asks for /approve-sensitive and the checklist on R2 stories", () => {
    const story = makeStory({ status: "in_review", riskTier: "R2_SENSITIVE", riskFlags: [{ category: "crime", origin: "rule", detail: "arrest" }] });
    const draft = makeDraft(story);
    const body = renderIssueBody({ story, draft, verificationLevel: "V2_OFFICIAL", sources: [], checks: [], possibleDuplicates: [], previewUrl: "https://x.example/p.jpg?sig=1" });
    expect(body).toContain(`/approve-sensitive ${shortHash(draft.revisionHash)}`);
    expect(body).toContain("Reviewer checklist (required before /approve-sensitive)");
    expect(body).toContain("Risk: R2_SENSITIVE (crime)");
    expect(body).toContain("![preview](<https://x.example/p.jpg?sig=1>)");
  });
});
