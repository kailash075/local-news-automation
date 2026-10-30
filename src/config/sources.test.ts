import { describe, expect, it } from "vitest";
import { IsoDateTimeSchema, SourceSchema, type Source } from "../domain/types.ts";
import { SOURCES, TERMS_REVIEW_MAX_AGE_DAYS, isCollectable, sourceById } from "./sources.ts";

const now = new Date("2026-10-30T06:00:00Z");

const approved = (overrides: Partial<Source> = {}): Source =>
  SourceSchema.parse({
    id: "test-feed",
    name: "Test feed",
    kind: "rss",
    url: "https://example.com/feed.xml",
    trustTier: "T1_official",
    erodeSpecific: false,
    termsReview: {
      status: "approved",
      reviewedBy: "kailash075",
      reviewedAt: "2026-10-01T00:00:00.000Z",
      notes: "Reviewed",
      allowedUse: "facts_with_attribution",
      llmInputAllowed: false,
    },
    fetchIntervalMinutes: 60,
    enabled: true,
    ...overrides,
  });

describe("source registry", () => {
  it("every external source is pending and disabled until the owner reviews it", () => {
    for (const s of SOURCES.filter((x) => x.kind !== "editor_tip")) {
      expect(s.termsReview.status).toBe("pending");
      expect(s.enabled).toBe(false);
      expect(s.termsReview.llmInputAllowed).toBe(false);
    }
  });

  it("Dinamalar is discovery only and never goes to an AI model", () => {
    const d = sourceById("dinamalar-erode");
    expect(d?.termsReview).toMatchObject({ allowedUse: "discovery_only", llmInputAllowed: false });
    expect(d?.termsReview.notes).toMatch(/GPTBot/);
  });

  it("ids are unique", () => {
    expect(new Set(SOURCES.map((s) => s.id)).size).toBe(SOURCES.length);
  });
});

describe("isCollectable", () => {
  it("regression: pending terms block collection", () => {
    for (const s of SOURCES) expect(isCollectable(s, now).ok).toBe(false);
    const pending = approved({ termsReview: { ...approved().termsReview, status: "pending" } });
    expect(isCollectable(pending, now)).toMatchObject({ ok: false, error: { code: "terms_not_approved" } });
  });

  it("allows an approved, enabled, recently reviewed source", () => {
    expect(isCollectable(approved(), now).ok).toBe(true);
  });

  it("blocks disabled sources, editor tips, undated or old reviews, and listing pages without a pattern", () => {
    expect(isCollectable(approved({ enabled: false }), now)).toMatchObject({ error: { code: "disabled" } });
    expect(isCollectable(approved({ kind: "editor_tip" }), now)).toMatchObject({ error: { code: "not_fetchable" } });
    const undated = { status: "approved", notes: "", allowedUse: "facts_with_attribution", llmInputAllowed: false } as const;
    expect(isCollectable(approved({ termsReview: undated }), now)).toMatchObject({ error: { code: "terms_review_undated" } });
    const old = new Date(now.getTime() - (TERMS_REVIEW_MAX_AGE_DAYS + 1) * 86_400_000).toISOString();
    expect(isCollectable(approved({ termsReview: { ...approved().termsReview, reviewedAt: IsoDateTimeSchema.parse(old) } }), now)).toMatchObject({
      error: { code: "terms_review_expired" },
    });
    expect(isCollectable(approved({ kind: "listing_page" }), now)).toMatchObject({ error: { code: "missing_link_pattern" } });
  });
});
