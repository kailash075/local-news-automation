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
  it("every external source the owner has not approved is disabled", () => {
    for (const s of SOURCES.filter((x) => x.kind !== "editor_tip" && x.termsReview.status !== "approved")) {
      expect(s.termsReview.status).toBe("pending");
      expect(s.enabled).toBe(false);
    }
  });

  it("no external source may send its text to an AI model", () => {
    for (const s of SOURCES) expect(s.termsReview.llmInputAllowed).toBe(false);
  });

  it("approved newspapers are discovery only, with the owner's dated review", () => {
    const papers = SOURCES.filter((s) => s.trustTier === "T2_established_publisher" && s.termsReview.status === "approved");
    expect(papers.map((s) => s.id).sort()).toEqual(["dinakaran-erode", "dinamalar-erode", "dinamani-erode", "hindutamil-erode", "polimer-erode"]);
    for (const s of papers) {
      expect(s.termsReview).toMatchObject({ allowedUse: "discovery_only", reviewedBy: "kailash075" });
      expect(isCollectable(s, new Date("2026-11-01T00:00:00Z")).ok).toBe(true);
    }
  });

  it("Google News and Bing News searches are not sources (robots.txt and Bing's feed terms)", () => {
    for (const s of SOURCES) expect(s.url).not.toMatch(/news\.google\.com|bing\.com/);
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

/** Real hrefs from each approved listing page, 2026-10-30, and links from the same pages that must not match. */
const LISTING_LINKS: Record<string, { article: readonly string[]; other: readonly string[] }> = {
  "dinamalar-erode": {
    article: ["/news/tamil-nadu-district-news-erode/workers-lay-siege-to-union-office-in-chennimalai/4362979", "/news/tamil-nadu-district-news-erode/a-small-onion/4362977"],
    other: ["/news/tamil-nadu-district-news-erode", "/news/tamil-nadu-district-news-coimbatore/some-story/4362900"],
  },
  "dinamani-erode": {
    article: ["/all-editions/edition-coimbatore/erode/2026/Oct/29/special-place-for-children-at-the-nalam-rehabilitation-centre"],
    other: ["/all-editions/edition-coimbatore/erode", "/all-editions/edition-coimbatore/tiruppur/2026/Oct/29/some-story"],
  },
  "dinakaran-erode": {
    article: ["https://www.dinakaran.com/district/erode_301026_3/", "https://www.dinakaran.com/district/erode_171026_3"],
    other: ["https://www.dinakaran.com/district/erode", "https://www.facebook.com/sharer/sharer.php?u=https://www.dinakaran.com/district/erode_301026_3/"],
  },
  "hindutamil-erode": {
    article: ["https://www.hindutamil.in/news/tamilnadu/sri-lankan-youngster-submits-request-at-erode-sp-office-seeking-an-identity-card"],
    other: ["https://www.hindutamil.in/topic/erode", "https://www.hindutamil.in/news/tamilnadu", "https://www.hindutamil.in/news/supplements/uyir-moochi", "/news/cinema/tamil-cinema", "/news/opinion/editorial"],
  },
};

describe("approved listing pages", () => {
  it.each(Object.entries(LISTING_LINKS))("%s link pattern matches articles only", (id, links) => {
    const pattern = new RegExp(sourceById(id)?.linkPattern ?? "^$");
    for (const href of links.article) expect(pattern.test(href), href).toBe(true);
    for (const href of links.other) expect(pattern.test(href), href).toBe(false);
  });
});

describe("isCollectable", () => {
  it("regression: pending terms block collection", () => {
    for (const s of SOURCES.filter((x) => x.termsReview.status !== "approved")) expect(isCollectable(s, now).ok).toBe(false);
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
