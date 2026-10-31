import { describe, expect, it } from "vitest";
import { runCollect } from "../src/app/collect.ts";
import { pendingDraftWork, runDrafts, type DraftDeps } from "../src/app/draft.ts";
import { runTriage } from "../src/app/triage.ts";
import type { FetchLike } from "../src/collectors/http.ts";
import { ok } from "../src/lib/result.ts";
import { syncSources } from "../src/sheet/stores.ts";
import { approvedSource, makeStory, newSourceItem, testSource } from "./support/fixtures.ts";
import { freshSheet, type TestSheet } from "./support/sheet.ts";

/**
 * Regression (Actions cost, 2026-10-31): every bridge request costs one to two seconds of a paid Actions minute, and the
 * draft check and draft job read each open story one by one, so every run got slower as stories piled up. These tests
 * pin the number of Sheet requests: it must not grow with the number of stories, items or sources.
 */

type Request = { op?: string; table?: string; ops?: readonly Request[] };

/** GitHub must not be touched while nothing expires. */
const noGitHub: DraftDeps["issues"] = {
  create: () => Promise.reject(new Error("unexpected")),
  update: () => Promise.reject(new Error("unexpected")),
  comment: () => Promise.reject(new Error("unexpected")),
  close: () => Promise.reject(new Error("unexpected")),
  findByMarker: () => Promise.resolve(ok(undefined)),
};

const requestsDuring = async (t: TestSheet, run: () => Promise<unknown>): Promise<readonly Request[]> => {
  const before = t.google.requests.length;
  await run();
  return t.google.requests.slice(before) as readonly Request[];
};

let nextIssue = 1;
const openStories = async (t: TestSheet, count: number): Promise<void> => {
  const stories = Array.from({ length: count }, () => makeStory(t.clock.now(), { status: "awaiting_caption" }));
  await t.stores.stories.insertMany(stories);
  for (const story of stories) await t.stores.reviewThreads.save(story.id, nextIssue++, 0);
};

const paper = testSource({ trustTier: "T2_established_publisher" });

describe("Sheet requests do not grow with the number of open stories", () => {
  it("draft check", async () => {
    const t = await freshSheet();
    const deps = { stores: t.stores, clock: t.clock, issues: noGitHub };
    await openStories(t, 2);
    const few = await requestsDuring(t, () => pendingDraftWork(deps));
    await openStories(t, 6);
    const many = await requestsDuring(t, () => pendingDraftWork(deps));
    expect(many).toHaveLength(few.length);
    expect(few.length).toBeLessThanOrEqual(5);
  });

  it("draft check that expires stories: one Sheet write for all of them", async () => {
    const t = await freshSheet();
    const closed: number[] = [];
    const issues: DraftDeps["issues"] = {
      ...noGitHub,
      comment: () => Promise.resolve(ok(undefined)),
      close: (n) => {
        closed.push(n);
        return Promise.resolve(ok(undefined));
      },
    };
    const deps = { stores: t.stores, clock: t.clock, issues };
    await openStories(t, 2);
    t.clock.advance(49 * 3_600_000);
    const few = await requestsDuring(t, () => pendingDraftWork(deps));
    await openStories(t, 6);
    t.clock.advance(49 * 3_600_000);
    const many = await requestsDuring(t, () => pendingDraftWork(deps));
    expect(many).toHaveLength(few.length);
    expect(many.filter((r) => r.op === "batch")).toHaveLength(1);
    expect(many.find((r) => r.op === "batch")?.ops).toHaveLength(6);
    expect(closed).toHaveLength(8);
    expect(await t.stores.stories.listByStatus(["expired"], 100)).toHaveLength(8);
  });

  it("draft run with nothing new to draft", async () => {
    const t = await freshSheet();
    const deps = {
      stores: t.stores,
      clock: t.clock,
      sourceFor: () => paper,
      objects: { put: () => Promise.reject(new Error("unexpected")), publicUrl: () => Promise.reject(new Error("unexpected")) },
      issues: noGitHub,
      renderer: () => Promise.reject(new Error("unexpected")),
    };
    await openStories(t, 2);
    const few = await requestsDuring(t, () => runDrafts(deps));
    await openStories(t, 6);
    const many = await requestsDuring(t, () => runDrafts(deps));
    expect(many).toHaveLength(few.length);
    expect(few.length).toBeLessThanOrEqual(7);
  });

  it("triage of new items", async () => {
    const t = await freshSheet();
    const triage = () => runTriage({ stores: t.stores, clock: t.clock, maxAgeHours: 48, sourceFor: () => paper });
    await t.stores.sourceItems.insertManyIfNew(["a", "b"].map((seed) => newSourceItem(seed, t.clock.now())));
    const few = await requestsDuring(t, triage);
    await t.stores.sourceItems.insertManyIfNew(["c", "d", "e", "f", "g", "h"].map((seed) => newSourceItem(seed, t.clock.now())));
    const many = await requestsDuring(t, triage);
    expect(many).toHaveLength(few.length);
    expect(few.length).toBeLessThanOrEqual(9);
  });

  it("collect: one fetch-state read per run, and one item write per source", async () => {
    const t = await freshSheet();
    const sources = [approvedSource("paper-a", "https://a.example/feed.xml"), approvedSource("paper-b", "https://b.example/feed.xml")];
    await syncSources(t.bridge, sources, t.clock);
    const feed = (site: string) =>
      `<?xml version="1.0"?><rss version="2.0"><channel>${[1, 2, 3]
        .map((n) => `<item><title>ஈரோடு செய்தி ${site} ${n}</title><link>https://${site}/news/${n}</link></item>`)
        .join("")}</channel></rss>`;
    const fetch: FetchLike = (input) =>
      Promise.resolve(input.endsWith("/robots.txt") ? new Response("") : new Response(feed(new URL(input).host)));
    const requests = await requestsDuring(t, () =>
      runCollect({ ...t.stores, scheduled: false, clock: t.clock, contactUrl: "https://example.org/contact", sources, fetch }),
    );
    const count = (op: string, table: string) => requests.filter((r) => r.op === op && r.table === table).length;
    expect(count("select", "sources")).toBe(1);
    expect(count("insert", "source_items")).toBe(2);
    expect(count("update", "sources")).toBe(2);
    expect(requests).toHaveLength(6);
    expect(await t.stores.sourceItems.listUnassigned(10)).toHaveLength(6);
  });
});
