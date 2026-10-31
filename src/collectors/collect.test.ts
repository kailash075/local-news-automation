import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { NewSourceItem, SourceFetchState, SourceStateStore } from "../domain/ports.ts";
import { IsoDateTimeSchema, SourceItemIdSchema, SourceSchema, type Source, type SourceId, type SourceItem } from "../domain/types.ts";
import { DISABLE_AFTER_FAILURES, MAX_ARTICLE_FETCHES_PER_RUN, collectSource, type CollectDeps, type RobotsCache } from "./collect.ts";
import type { FetchLike } from "./http.ts";

const CONTACT = "https://github.com/kailash075/local-news-automation";
const now = new Date("2026-10-30T06:00:00Z");

const source = (overrides: Partial<Source> = {}): Source =>
  SourceSchema.parse({
    id: "test-feed",
    name: "Test feed",
    kind: "rss",
    url: "https://example.com/feed.xml",
    trustTier: "T1_official",
    erodeSpecific: true,
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

const FEED = `<?xml version="1.0"?><rss version="2.0"><channel>
<item><title>ஈரோட்டில் நாளை மின்தடை</title><link>https://example.com/news/1?utm_source=rss</link>
<pubDate>Thu, 30 Oct 2026 05:00:00 +0530</pubDate><description>${"முழு கட்டுரை ".repeat(200)}</description></item>
<item><title>Second</title><link>https://example.com/news/2</link></item>
<item><title>Bad link</title><link>javascript:alert(1)</link></item>
</channel></rss>`;

class MemoryStores {
  readonly states = new Map<SourceId, SourceFetchState>();
  readonly items: SourceItem[] = [];
  /** Size of each item write, to check that a page is stored in one request. */
  readonly writes: number[] = [];

  readonly sourceState: SourceStateStore = {
    getFetchState: (sourceId) => Promise.resolve(this.states.get(sourceId) ?? { sourceId, consecutiveFailures: 0 }),
    saveFetchState: (state) => {
      this.states.set(state.sourceId, state);
      return Promise.resolve();
    },
  };

  readonly sourceItems: CollectDeps["sourceItems"] = {
    insertManyIfNew: (batch: readonly NewSourceItem[]) => {
      this.writes.push(batch.length);
      const stored: SourceItem[] = [];
      for (const item of batch) {
        if (this.items.some((i) => i.sourceId === item.sourceId && i.urlHash === item.urlHash)) continue;
        const next: SourceItem = { ...item, id: SourceItemIdSchema.parse(randomUUID()) };
        this.items.push(next);
        stored.push(next);
      }
      return Promise.resolve(stored);
    },
    isKnown: (sourceId, urlHash) => Promise.resolve(this.items.some((i) => i.sourceId === sourceId && i.urlHash === urlHash)),
  };
}

type Route = (headers: Headers) => Response;

const router = (routes: Record<string, Route>): { fetch: FetchLike; calls: string[] } => {
  const calls: string[] = [];
  const fetch: FetchLike = (input, init) => {
    calls.push(input);
    const route = routes[input];
    if (route === undefined) return Promise.resolve(new Response("not found", { status: 404 }));
    return Promise.resolve(route(new Headers(init?.headers)));
  };
  return { fetch, calls };
};

const deps = (stores: MemoryStores, fetch: FetchLike, extra: Partial<CollectDeps> = {}): CollectDeps => ({
  clock: { now: () => now },
  sourceState: stores.sourceState,
  sourceItems: stores.sourceItems,
  contactUrl: CONTACT,
  fetch,
  ...extra,
});

describe("collectSource", () => {
  it("stores new items with metadata and a short excerpt only", async () => {
    const stores = new MemoryStores();
    const { fetch } = router({
      "https://example.com/robots.txt": () => new Response("User-agent: *\nDisallow: /private/\n"),
      "https://example.com/feed.xml": () => new Response(FEED, { headers: { etag: '"v1"' } }),
    });
    const out = await collectSource(source(), deps(stores, fetch));
    expect(out).toMatchObject({ status: "fetched", seen: 3, invalid: 1 });
    expect(stores.items).toHaveLength(2);
    const first = stores.items[0];
    expect(first?.canonicalUrl).toBe("https://example.com/news/1");
    expect(first?.language).toBe("ta");
    expect(first?.publishedAt).toBe("2026-10-29T23:30:00.000Z");
    expect(first?.excerpt?.length ?? 0).toBeLessThanOrEqual(500);
    expect(stores.states.get(source().id)).toMatchObject({ etag: '"v1"', consecutiveFailures: 0, lastFetchedAt: now.toISOString() });
  });

  it("does not store the same URL twice", async () => {
    const stores = new MemoryStores();
    const { fetch } = router({
      "https://example.com/robots.txt": () => new Response("", { status: 404 }),
      "https://example.com/feed.xml": () => new Response(FEED),
    });
    await collectSource(source(), deps(stores, fetch));
    const later = { now: () => new Date(now.getTime() + 2 * 3_600_000) };
    const out = await collectSource(source(), deps(stores, fetch, { clock: later }));
    expect(out).toMatchObject({ status: "fetched", inserted: [] });
    expect(stores.items).toHaveLength(2);
  });

  it("regression: pending terms block the fetch entirely", async () => {
    const stores = new MemoryStores();
    const { fetch, calls } = router({});
    const pending = source({ termsReview: { ...source().termsReview, status: "pending" } });
    const out = await collectSource(pending, deps(stores, fetch));
    expect(out).toMatchObject({ status: "skipped" });
    expect(calls).toEqual([]);
  });

  it("regression: a robots.txt disallow blocks the fetch", async () => {
    const stores = new MemoryStores();
    const { fetch, calls } = router({
      "https://example.com/robots.txt": () => new Response("User-agent: *\nDisallow: /feed.xml\n"),
      "https://example.com/feed.xml": () => new Response(FEED),
    });
    const out = await collectSource(source(), deps(stores, fetch));
    expect(out).toMatchObject({ status: "skipped", reason: "robots.txt disallows /feed.xml" });
    expect(calls).toEqual(["https://example.com/robots.txt"]);
  });

  it("an unreachable robots.txt (5xx) is treated as disallow and counts as a failure", async () => {
    const stores = new MemoryStores();
    const { fetch, calls } = router({ "https://example.com/robots.txt": () => new Response("oops", { status: 500 }) });
    const out = await collectSource(source(), deps(stores, fetch));
    expect(out).toMatchObject({ status: "failed", consecutiveFailures: 1, shouldDisable: false });
    expect(calls).toEqual(["https://example.com/robots.txt"]);
  });

  it("caches robots.txt per origin within a run", async () => {
    const stores = new MemoryStores();
    const robotsCache: RobotsCache = new Map();
    const { fetch, calls } = router({
      "https://example.com/robots.txt": () => new Response(""),
      "https://example.com/feed.xml": () => new Response(FEED),
      "https://example.com/other.xml": () => new Response(FEED),
    });
    await collectSource(source(), deps(stores, fetch, { robotsCache }));
    await collectSource(source({ id: SourceSchema.shape.id.parse("other-feed"), url: "https://example.com/other.xml" }), deps(stores, fetch, { robotsCache }));
    expect(calls.filter((c) => c.endsWith("/robots.txt"))).toHaveLength(1);
  });

  it("uses conditional GET and handles 304", async () => {
    const stores = new MemoryStores();
    stores.states.set(source().id, { sourceId: source().id, etag: '"v1"', consecutiveFailures: 2 });
    let seenEtag: string | null = null;
    const { fetch } = router({
      "https://example.com/robots.txt": () => new Response(""),
      "https://example.com/feed.xml": (h) => {
        seenEtag = h.get("if-none-match");
        return new Response(null, { status: 304 });
      },
    });
    const out = await collectSource(source(), deps(stores, fetch));
    expect(out).toEqual({ status: "not_modified", sourceId: "test-feed" });
    expect(seenEtag).toBe('"v1"');
    expect(stores.states.get(source().id)?.consecutiveFailures).toBe(0);
  });

  it("skips a source that is not due yet", async () => {
    const stores = new MemoryStores();
    stores.states.set(source().id, {
      sourceId: source().id,
      consecutiveFailures: 0,
      lastFetchedAt: IsoDateTimeSchema.parse(new Date(now.getTime() - 10 * 60_000).toISOString()),
    });
    const { fetch, calls } = router({});
    expect(await collectSource(source(), deps(stores, fetch))).toMatchObject({ status: "skipped", reason: "not due yet" });
    expect(calls).toEqual([]);
  });

  it(`counts consecutive failures and asks to disable after ${DISABLE_AFTER_FAILURES}`, async () => {
    const stores = new MemoryStores();
    stores.states.set(source().id, { sourceId: source().id, consecutiveFailures: DISABLE_AFTER_FAILURES - 1 });
    const { fetch } = router({
      "https://example.com/robots.txt": () => new Response(""),
      "https://example.com/feed.xml": () => new Response("<html>not a feed</html>"),
    });
    const out = await collectSource(source(), deps(stores, fetch));
    expect(out).toMatchObject({ status: "failed", consecutiveFailures: DISABLE_AFTER_FAILURES, shouldDisable: true });
  });

  const listing = source({
    id: SourceSchema.shape.id.parse("erode-page"),
    kind: "listing_page",
    url: "https://example.com/district/erode",
    linkPattern: "^(/news/\\d+)$",
  });
  const LISTING = '<a href="/news/7">பவானியில் சாலை பணி</a><a href="/news/8">கொடுமுடியில் விழா</a><a href="/about">About</a>';
  const article = (published: string): Route => () => new Response(`<meta property="article:published_time" content="${published}">`);

  it("reads titles from a listing page and each new article's publication time", async () => {
    const stores = new MemoryStores();
    const pauses: number[] = [];
    const { fetch } = router({
      "https://example.com/robots.txt": () => new Response(""),
      "https://example.com/district/erode": () => new Response(LISTING),
      "https://example.com/news/7": article("2026-10-30T09:00:00+05:30"),
      "https://example.com/news/8": () => new Response('{"datePublished":"2026-10-29T20:00:00Z"}'),
    });
    const out = await collectSource(listing, deps(stores, fetch, { pause: (ms) => (pauses.push(ms), Promise.resolve()) }));
    expect(out).toMatchObject({ status: "fetched", seen: 2, undated: 0 });
    expect(stores.items.map((i) => [i.title, i.publishedAt])).toEqual([
      ["பவானியில் சாலை பணி", "2026-10-30T03:30:00.000Z"],
      ["கொடுமுடியில் விழா", "2026-10-29T20:00:00.000Z"],
    ]);
    expect(pauses).toHaveLength(1); // between the two article requests, not before the first
  });

  it("stores a whole page in one write", async () => {
    const stores = new MemoryStores();
    const { fetch } = router({
      "https://example.com/robots.txt": () => new Response(""),
      "https://example.com/district/erode": () => new Response(LISTING),
      "https://example.com/news/7": article("2026-10-30T09:00:00+05:30"),
      "https://example.com/news/8": article("2026-10-30T09:30:00+05:30"),
    });
    await collectSource(listing, deps(stores, fetch, { pause: () => Promise.resolve() }));
    expect(stores.writes).toEqual([2]);
    expect(stores.items.map((i) => i.canonicalUrl)).toEqual(["https://example.com/news/7", "https://example.com/news/8"]);
  });

  it("makes no write when nothing on the page is new", async () => {
    const stores = new MemoryStores();
    const { fetch } = router({
      "https://example.com/robots.txt": () => new Response(""),
      "https://example.com/district/erode": () => new Response(LISTING),
      "https://example.com/news/7": () => new Response("<p>no date here</p>"),
      "https://example.com/news/8": () => new Response("<p>no date here</p>"),
    });
    await collectSource(listing, deps(stores, fetch, { pause: () => Promise.resolve() }));
    expect(stores.writes).toEqual([]);
  });

  it("regression: an article without a readable date is not stored, so old news cannot pass as new", async () => {
    const stores = new MemoryStores();
    const { fetch } = router({
      "https://example.com/robots.txt": () => new Response(""),
      "https://example.com/district/erode": () => new Response(LISTING),
      "https://example.com/news/7": () => new Response("<p>no date here</p>"),
      "https://example.com/news/8": article("2099-01-01T00:00:00Z"),
    });
    const out = await collectSource(listing, deps(stores, fetch, { pause: () => Promise.resolve() }));
    expect(out).toMatchObject({ status: "fetched", seen: 2, undated: 2, inserted: [] });
    expect(stores.items).toEqual([]);
  });

  it("does not open known articles again, and obeys robots.txt for article paths", async () => {
    const stores = new MemoryStores();
    const routes = {
      "https://example.com/robots.txt": () => new Response("User-agent: *\nDisallow: /news/8\n"),
      "https://example.com/district/erode": () => new Response(LISTING),
      "https://example.com/news/7": article("2026-10-30T05:00:00Z"),
      "https://example.com/news/8": article("2026-10-30T05:00:00Z"),
    };
    const first = router(routes);
    expect(await collectSource(listing, deps(stores, first.fetch, { pause: () => Promise.resolve() }))).toMatchObject({ undated: 1 });
    expect(first.calls).not.toContain("https://example.com/news/8");
    expect(stores.items).toHaveLength(1);

    const second = router(routes);
    const later = new Date(now.getTime() + 2 * 3_600_000);
    await collectSource(listing, deps(stores, second.fetch, { clock: { now: () => later }, pause: () => Promise.resolve() }));
    expect(second.calls).not.toContain("https://example.com/news/7");
  });

  it("opens at most MAX_ARTICLE_FETCHES_PER_RUN articles per run", async () => {
    const stores = new MemoryStores();
    const count = MAX_ARTICLE_FETCHES_PER_RUN + 3;
    const links = Array.from({ length: count }, (_, i) => `<a href="/news/${i + 1}">செய்தி ${i + 1}</a>`).join("");
    const { fetch, calls } = router({
      "https://example.com/robots.txt": () => new Response(""),
      "https://example.com/district/erode": () => new Response(links),
      ...Object.fromEntries(Array.from({ length: count }, (_, i) => [`https://example.com/news/${i + 1}`, article("2026-10-30T05:00:00Z")])),
    });
    const out = await collectSource(listing, deps(stores, fetch, { pause: () => Promise.resolve() }));
    expect(out).toMatchObject({ undated: 3 });
    expect(calls.filter((c) => c.includes("/news/"))).toHaveLength(MAX_ARTICLE_FETCHES_PER_RUN);
  });
});
