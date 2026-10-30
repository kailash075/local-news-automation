import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { NewSourceItem, SourceFetchState, SourceItemStore, SourceStateStore } from "../domain/ports.ts";
import { IsoDateTimeSchema, SourceItemIdSchema, SourceSchema, type Source, type SourceId, type SourceItem } from "../domain/types.ts";
import { DISABLE_AFTER_FAILURES, collectSource, type CollectDeps, type RobotsCache } from "./collect.ts";
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

  readonly sourceState: SourceStateStore = {
    getFetchState: (sourceId) => Promise.resolve(this.states.get(sourceId) ?? { sourceId, consecutiveFailures: 0 }),
    saveFetchState: (state) => {
      this.states.set(state.sourceId, state);
      return Promise.resolve();
    },
  };

  readonly sourceItems: SourceItemStore = {
    insertIfNew: (item: NewSourceItem) => {
      if (this.items.some((i) => i.sourceId === item.sourceId && i.urlHash === item.urlHash)) return Promise.resolve({ inserted: false });
      const stored: SourceItem = { ...item, id: SourceItemIdSchema.parse(randomUUID()) };
      this.items.push(stored);
      return Promise.resolve({ inserted: true, item: stored });
    },
    listUnassigned: () => Promise.resolve(this.items),
    attachToStory: () => Promise.resolve(),
    listForStory: () => Promise.resolve([]),
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

  it("reads titles from a listing page with the source's link pattern", async () => {
    const stores = new MemoryStores();
    const listing = source({
      id: SourceSchema.shape.id.parse("erode-page"),
      kind: "listing_page",
      url: "https://example.com/district/erode",
      linkPattern: "^(/news/\\d+)$",
    });
    const { fetch } = router({
      "https://example.com/robots.txt": () => new Response(""),
      "https://example.com/district/erode": () =>
        new Response('<a href="/news/7">பவானியில் சாலை பணி</a><a href="/news/8">கொடுமுடியில் விழா</a><a href="/about">About</a>'),
    });
    const out = await collectSource(listing, deps(stores, fetch));
    expect(out).toMatchObject({ status: "fetched", seen: 2 });
    expect(stores.items.map((i) => i.title)).toEqual(["பவானியில் சாலை பணி", "கொடுமுடியில் விழா"]);
  });
});
