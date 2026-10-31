import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createMemoryStores } from "../../test/support/memory-stores.ts";
import { testClock } from "../../test/support/clock.ts";
import { approvedSource } from "../../test/support/fixtures.ts";
import type { FetchLike } from "../collectors/http.ts";
import type { Source } from "../domain/types.ts";
import { dryRunCollectStores, runCollect, type CollectRunDeps } from "./collect.ts";

const feed = (...links: readonly string[]): string =>
  `<?xml version="1.0"?><rss version="2.0"><channel>${links
    .map((link, i) => `<item><title>ஈரோடு செய்தி ${i + 1}</title><link>${link}</link><pubDate>Fri, 30 Oct 2026 09:00:00 +0530</pubDate></item>`)
    .join("")}</channel></rss>`;

/** Serves robots.txt (allow all) and the given feeds, and records how many requests each site had open at once. */
const sites = (feeds: Readonly<Record<string, string>>, delayMs = 0) => {
  const open = new Map<string, number>();
  const mostOpen = new Map<string, number>();
  let allOpen = 0;
  let mostAllOpen = 0;
  const fetch: FetchLike = async (input) => {
    const origin = new URL(input).origin;
    open.set(origin, (open.get(origin) ?? 0) + 1);
    mostOpen.set(origin, Math.max(mostOpen.get(origin) ?? 0, open.get(origin) ?? 0));
    allOpen += 1;
    mostAllOpen = Math.max(mostAllOpen, allOpen);
    try {
      await sleep(delayMs);
      if (input.endsWith("/robots.txt")) return new Response("");
      const body = feeds[input];
      return body === undefined ? new Response("not found", { status: 404 }) : new Response(body);
    } finally {
      open.set(origin, (open.get(origin) ?? 1) - 1);
      allOpen -= 1;
    }
  };
  return { fetch, mostOpen, mostAllOpen: () => mostAllOpen };
};

const setup = (sources: readonly Source[], fetch: FetchLike) => {
  const clock = testClock();
  const stores = createMemoryStores(clock);
  const deps: CollectRunDeps = {
    settings: stores.settings,
    scheduled: false,
    sourceState: stores.sourceState,
    sourceItems: stores.sourceItems,
    clock,
    contactUrl: "https://example.org/contact",
    sources,
    fetch,
  };
  return { stores, deps };
};

describe("runCollect", () => {
  it("collects different sites at the same time, one request at a time per site, and reports in registry order", async () => {
    const a1 = approvedSource("site-a-one", "https://a.example/one.xml");
    const a2 = approvedSource("site-a-two", "https://a.example/two.xml");
    const b = approvedSource("site-b", "https://b.example/feed.xml");
    const net = sites(
      {
        "https://a.example/one.xml": feed("https://a.example/news/1"),
        "https://a.example/two.xml": feed("https://a.example/news/2"),
        "https://b.example/feed.xml": feed("https://b.example/news/1", "https://b.example/news/2"),
      },
      5,
    );
    const { deps } = setup([a1, a2, b], net.fetch);
    const report = await runCollect(deps);
    expect(report).toMatchObject({ status: "done", newItems: 4 });
    if (report.status !== "done") return;
    expect(report.lines.map((l) => l.split(":")[0])).toEqual(["- site-a-one", "- site-a-two", "- site-b"]);
    expect(net.mostOpen.get("https://a.example")).toBe(1);
    expect(net.mostOpen.get("https://b.example")).toBe(1);
    expect(net.mostAllOpen()).toBe(2);
  });

  it("lets the other sites finish when the Sheet fails for one, then fails the run", async () => {
    const a = approvedSource("site-a", "https://a.example/feed.xml");
    const b = approvedSource("site-b", "https://b.example/feed.xml");
    const net = sites({ "https://a.example/feed.xml": feed("https://a.example/news/1"), "https://b.example/feed.xml": feed("https://b.example/news/1") });
    const { stores, deps } = setup([a, b], net.fetch);
    const failing: CollectRunDeps["sourceItems"] = {
      isKnown: stores.sourceItems.isKnown,
      insertManyIfNew: (items) =>
        items.some((i) => i.sourceId === a.id) ? Promise.reject(new Error("bridge refused insert: busy")) : stores.sourceItems.insertManyIfNew(items),
    };
    await expect(runCollect({ ...deps, sourceItems: failing })).rejects.toThrow("busy");
    expect((await stores.sourceItems.listUnassigned(10)).map((i) => i.sourceId)).toEqual([b.id]);
    expect((await stores.sourceState.getFetchState(b.id)).lastFetchedAt).toBeDefined();
  });

  it("dry run: fetches and counts only really new items, and writes nothing", async () => {
    const source = approvedSource("site-a", "https://a.example/feed.xml");
    const net = sites({ "https://a.example/feed.xml": feed("https://a.example/news/1", "https://a.example/news/2") });
    const { stores, deps } = setup([source], net.fetch);
    const first = await runCollect(deps);
    expect(first).toMatchObject({ newItems: 2 });

    const more = sites({ "https://a.example/feed.xml": feed("https://a.example/news/1", "https://a.example/news/2", "https://a.example/news/3") });
    const stateBefore = await stores.sourceState.getFetchState(source.id);
    const dry = await runCollect({ ...deps, ...dryRunCollectStores(stores), fetch: more.fetch });
    expect(dry).toMatchObject({ status: "done", newItems: 1 });
    expect(await stores.sourceItems.listUnassigned(10)).toHaveLength(2);
    expect(await stores.sourceState.getFetchState(source.id)).toEqual(stateBefore);
  });
});
