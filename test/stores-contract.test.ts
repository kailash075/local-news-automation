import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Stores } from "../src/domain/ports.ts";
import { GitHubLoginSchema, IsoDateTimeSchema, StoryIdSchema, type Publication } from "../src/domain/types.ts";
import { uuidv7 } from "../src/lib/ids.ts";
import { testClock, type TestClock } from "./support/clock.ts";
import { iso, makeDraft, makePublication, makeStory, newSourceItem, TEST_SOURCE_ID } from "./support/fixtures.ts";
import { createMemoryStores } from "./support/memory-stores.ts";
import { freshSheet } from "./support/sheet.ts";

/**
 * The same behaviour, checked against the Google Sheet stores (the real bridge code on a fake Sheet) and the in-memory
 * stores used by job tests.
 * If the two ever disagree, job unit tests would be testing a fiction.
 */

type Harness = { stores: Stores; clock: TestClock; close: () => Promise<void> };

const implementations: readonly (readonly [string, () => Promise<Harness>])[] = [
  [
    "google sheet (bridge on a fake Sheet)",
    async () => {
      const t = await freshSheet();
      return { stores: t.stores, clock: t.clock, close: () => Promise.resolve() };
    },
  ],
  [
    "memory",
    () => {
      const clock = testClock();
      return Promise.resolve({ stores: createMemoryStores(clock), clock, close: () => Promise.resolve() });
    },
  ],
];

const MINUTE = 60_000;
const editor = GitHubLoginSchema.parse("kailash075");

describe.each(implementations)("stores contract: %s", (_name, open) => {
  let h: Harness;
  let s: Stores;
  beforeEach(async () => {
    h = await open();
    s = h.stores;
  });
  afterEach(async () => {
    await h.close();
  });

  describe("settings", () => {
    it("read a switch that was never set as off: collecting paused, kill switch not pulled", async () => {
      expect(await s.settings.getSwitch("collecting_enabled")).toEqual({
        enabled: false,
        reason: "not set",
        updatedBy: "system",
      });
      expect((await s.settings.getSwitch("kill_switch")).enabled).toBe(false);
    });

    it("store who changed a switch and why", async () => {
      await s.settings.setSwitch("kill_switch", true, "kailash075", "/killswitch on #12: wrong photo credit");
      await s.settings.setSwitch("kill_switch", false, "kailash075", "/killswitch off #12");
      const state = await s.settings.getSwitch("kill_switch");
      expect(state).toMatchObject({ enabled: false, updatedBy: "kailash075", reason: "/killswitch off #12" });
      expect(state.updatedAt).toBe(iso(h.clock.now()));
      expect((await s.settings.getSwitch("collecting_enabled")).enabled).toBe(false);
    });
  });

  describe("source fetch state", () => {
    it("starts empty and round-trips", async () => {
      expect(await s.sourceState.getFetchState(TEST_SOURCE_ID)).toEqual({ sourceId: TEST_SOURCE_ID, consecutiveFailures: 0 });
      const state = {
        sourceId: TEST_SOURCE_ID,
        etag: 'W/"abc"',
        lastModified: "Thu, 29 Oct 2026 10:00:00 GMT",
        lastFetchedAt: iso(h.clock.now()),
        consecutiveFailures: 2,
      };
      await s.sourceState.saveFetchState(state);
      expect(await s.sourceState.getFetchState(TEST_SOURCE_ID)).toEqual(state);
      await s.sourceState.saveFetchState({ sourceId: TEST_SOURCE_ID, consecutiveFailures: 0 });
      expect(await s.sourceState.getFetchState(TEST_SOURCE_ID)).toEqual({ sourceId: TEST_SOURCE_ID, consecutiveFailures: 0 });
    });
  });

  describe("source items and stories", () => {
    it("insert each (source, url) once and keep optional fields absent", async () => {
      const a = newSourceItem("a", h.clock.now());
      expect(await s.sourceItems.isKnown(a.sourceId, a.urlHash)).toBe(false);
      const first = await s.sourceItems.insertIfNew(a);
      expect(first.inserted).toBe(true);
      expect(await s.sourceItems.isKnown(a.sourceId, a.urlHash)).toBe(true);
      if (!first.inserted) return;
      expect(first.item).not.toHaveProperty("excerpt");
      expect(first.item).not.toHaveProperty("publishedAt");
      expect(await s.sourceItems.insertIfNew(newSourceItem("a", h.clock.now(), { title: "changed" }))).toEqual({ inserted: false });

      const withOptional = await s.sourceItems.insertIfNew(
        newSourceItem("b", h.clock.now(), { excerpt: "சுருக்கம்", publishedAt: iso(new Date("2026-10-30T02:00:00Z")) }),
      );
      expect(withOptional.inserted && withOptional.item.excerpt).toBe("சுருக்கம்");
    });

    it("list unassigned items oldest first and attach them to stories", async () => {
      const a = await s.sourceItems.insertIfNew(newSourceItem("a", h.clock.now()));
      h.clock.advance(MINUTE);
      const b = await s.sourceItems.insertIfNew(newSourceItem("b", h.clock.now()));
      if (!a.inserted || !b.inserted) throw new Error("expected inserts");
      expect((await s.sourceItems.listUnassigned(10)).map((i) => i.id)).toEqual([a.item.id, b.item.id]);
      expect(await s.sourceItems.listUnassigned(1)).toHaveLength(1);

      const story = makeStory(h.clock.now());
      await s.stories.insert(story);
      await s.sourceItems.attachToStory(a.item.id, story.id, "primary");
      await s.sourceItems.attachToStory(a.item.id, story.id, "primary");
      expect((await s.sourceItems.listUnassigned(10)).map((i) => i.id)).toEqual([b.item.id]);
      expect((await s.sourceItems.listForStory(story.id)).map((i) => i.id)).toEqual([a.item.id]);

      const recent = await s.stories.listRecentWithItems(iso(new Date(h.clock.now().getTime() - 60 * MINUTE)));
      expect(recent).toHaveLength(1);
      expect(recent[0]?.items.map((i) => i.id)).toEqual([a.item.id]);
      expect(await s.stories.listRecentWithItems(iso(new Date(h.clock.now().getTime() + MINUTE)))).toEqual([]);
    });

    it("update stories with optimistic concurrency", async () => {
      const story = makeStory(h.clock.now(), { expiresAt: iso(new Date("2026-10-30T12:00:00Z")) });
      await s.stories.insert(story);
      expect(await s.stories.get(story.id)).toEqual(story);

      const updated = await s.stories.update({ ...story, status: "triaged", priority: 5 }, 0);
      expect(updated.ok && updated.value).toMatchObject({ status: "triaged", priority: 5, version: 1 });

      const stale = await s.stories.update({ ...story, status: "discarded" }, 0);
      expect(stale).toEqual({ ok: false, error: "version_conflict" });

      const withoutExpiry = { ...story, status: "triaged" as const };
      delete withoutExpiry.expiresAt;
      const cleared = await s.stories.update(withoutExpiry, 1);
      expect(cleared.ok && cleared.value.expiresAt).toBeUndefined();
      expect((await s.stories.get(story.id))?.version).toBe(2);

      const missing = await s.stories.update({ ...story, id: StoryIdSchema.parse(uuidv7()) }, 0);
      expect(missing).toEqual({ ok: false, error: "not_found" });
    });

    it("list stories by status, most urgent first", async () => {
      // Regression (first real draft run, 2026-10-30): priorities have decimals, and the Sheet must read them back.
      const low = makeStory(h.clock.now(), { status: "triaged", priority: 1.25 });
      const high = makeStory(h.clock.now(), { status: "triaged", priority: 9, topic: "weather" });
      const other = makeStory(h.clock.now(), { status: "discarded", priority: 99 });
      for (const story of [low, high, other]) await s.stories.insert(story);
      expect((await s.stories.listByStatus(["triaged"], 10)).map((x) => x.id)).toEqual([high.id, low.id]);
      expect((await s.stories.get(low.id))?.priority).toBe(1.25);
      expect(await s.stories.listByStatus([], 10)).toEqual([]);
    });
  });

  describe("drafts, evidence, decisions, review threads", () => {
    it("return the latest draft revision", async () => {
      const story = makeStory(h.clock.now());
      await s.stories.insert(story);
      expect(await s.drafts.latestFor(story.id)).toBeUndefined();
      const d1 = makeDraft(story.id, h.clock.now(), 1);
      const d2 = makeDraft(story.id, h.clock.now(), 2, { renderKey: "renders/2026/10/abc.jpg" });
      await s.drafts.insert(d1);
      await s.drafts.insert(d2);
      expect(await s.drafts.latestFor(story.id)).toEqual(d2);
      expect(await s.drafts.get(d1.id)).toEqual(d1);
    });

    it("round-trip every evidence kind", async () => {
      const story = makeStory(h.clock.now());
      await s.stories.insert(story);
      const a = await s.sourceItems.insertIfNew(newSourceItem("a", h.clock.now()));
      const b = await s.sourceItems.insertIfNew(newSourceItem("b", h.clock.now()));
      if (!a.inserted || !b.inserted) throw new Error("expected inserts");
      const evidence = [
        { kind: "official_source" as const, sourceItemId: a.item.id },
        { kind: "independent_corroboration" as const, sourceItemIds: [a.item.id, b.item.id] as const },
        {
          kind: "editor_attestation" as const,
          editorLogin: editor,
          method: "Called the Erode EB office, 10:40 IST",
          attestedAt: iso(h.clock.now()),
        },
      ];
      for (const e of evidence) {
        await s.evidence.add(story.id, e);
        h.clock.advance(1000);
      }
      expect(await s.evidence.listFor(story.id)).toEqual(evidence);
    });

    it("record a GitHub comment only once", async () => {
      const story = makeStory(h.clock.now());
      await s.stories.insert(story);
      const decision = {
        storyId: story.id,
        kind: "approve" as const,
        editorLogin: editor,
        githubCommentId: 2_147_483_648,
        revisionHash: makeDraft(story.id, h.clock.now()).revisionHash,
        createdAt: iso(h.clock.now()),
      };
      expect(await s.decisions.record(decision)).toEqual({ recorded: true });
      expect(await s.decisions.record(decision)).toEqual({ recorded: false });
      expect(await s.decisions.listFor(story.id)).toEqual([decision]);
    });

    it("map stories to review issues both ways", async () => {
      const story = makeStory(h.clock.now());
      await s.stories.insert(story);
      expect(await s.reviewThreads.getIssueNumber(story.id)).toBeUndefined();
      await s.reviewThreads.save(story.id, 17, 1);
      await s.reviewThreads.save(story.id, 17, 2);
      expect(await s.reviewThreads.getIssueNumber(story.id)).toBe(17);
      expect(await s.reviewThreads.getStoryId(17)).toBe(story.id);
      expect(await s.reviewThreads.getStoryId(18)).toBeUndefined();
    });
  });

  describe("publications", () => {
    const setup = async (offsetMinutes = 0): Promise<Publication> => {
      const story = makeStory(h.clock.now());
      await s.stories.insert(story);
      const draft = makeDraft(story.id, h.clock.now());
      await s.drafts.insert(draft);
      return s.publications.createIfAbsent(
        makePublication(story.id, draft, new Date(h.clock.now().getTime() + offsetMinutes * MINUTE)),
      );
    };

    it("create once per idempotency key", async () => {
      const p = await setup();
      const again = await s.publications.createIfAbsent({ ...p, scheduledFor: iso(new Date("2026-11-01T00:00:00Z")) });
      expect(again).toEqual(p);
      expect(await s.publications.get(p.id)).toEqual(p);
    });

    it("let exactly one worker claim a due publication", async () => {
      const p = await setup();
      const now = h.clock.now();
      const first = await s.publications.claimDue(now, "run-1", 5 * MINUTE);
      const second = await s.publications.claimDue(now, "run-2", 5 * MINUTE);
      expect(first).toMatchObject({ id: p.id, leaseOwner: "run-1", leaseExpiresAt: iso(new Date(now.getTime() + 5 * MINUTE)) });
      expect(second).toBeUndefined();
    });

    it("do not claim publications scheduled in the future or backing off", async () => {
      await setup(30);
      expect(await s.publications.claimDue(h.clock.now(), "run-1", MINUTE)).toBeUndefined();
      h.clock.advance(31 * MINUTE);
      const claimed = await s.publications.claimDue(h.clock.now(), "run-1", MINUTE);
      expect(claimed).toBeDefined();
      if (claimed === undefined) return;
      h.clock.advance(10);
      const saved = await s.publications.save(
        { ...claimed, attempts: 1, nextAttemptAt: iso(new Date(h.clock.now().getTime() + 10 * MINUTE)) },
        "run-1",
      );
      expect(saved.ok).toBe(true);
      await s.publications.release(claimed.id, "run-1");
      expect(await s.publications.claimDue(h.clock.now(), "run-2", MINUTE)).toBeUndefined();
      h.clock.advance(11 * MINUTE);
      expect((await s.publications.claimDue(h.clock.now(), "run-2", MINUTE))?.id).toBe(claimed.id);
    });

    it("claim a specific publication by id only while its lease is free", async () => {
      const p = await setup(60);
      const first = await s.publications.claimById(p.id, "reconcile-1", MINUTE);
      expect(first).toMatchObject({ id: p.id, leaseOwner: "reconcile-1" });
      expect(await s.publications.claimById(p.id, "reconcile-2", MINUTE)).toBeUndefined();
      h.clock.advance(2 * MINUTE);
      expect((await s.publications.claimById(p.id, "reconcile-2", MINUTE))?.leaseOwner).toBe("reconcile-2");
    });

    it("let another worker reclaim an expired lease, and refuse saves from the old holder", async () => {
      const p = await setup();
      const claimed = await s.publications.claimDue(h.clock.now(), "run-1", MINUTE);
      expect(claimed?.id).toBe(p.id);
      h.clock.advance(2 * MINUTE);
      const reclaimed = await s.publications.claimDue(h.clock.now(), "run-2", MINUTE);
      expect(reclaimed?.leaseOwner).toBe("run-2");
      expect(await s.publications.save({ ...p, status: "container_created", containerId: "c1" }, "run-1")).toEqual({
        ok: false,
        error: "lease_lost",
      });
      const saved = await s.publications.save({ ...p, status: "container_created", containerId: "c2" }, "run-2");
      expect(saved.ok && saved.value).toMatchObject({ containerId: "c2", leaseOwner: "run-2" });
    });

    it("refuse saves once the holder's own lease has expired", async () => {
      const p = await setup();
      await s.publications.claimDue(h.clock.now(), "run-1", MINUTE);
      h.clock.advance(MINUTE);
      expect(await s.publications.save({ ...p, status: "publish_requested" }, "run-1")).toEqual({ ok: false, error: "lease_lost" });
      expect((await s.publications.get(p.id))?.status).toBe("pending");
    });

    it("do not let save change the lease or identity columns", async () => {
      const p = await setup();
      await s.publications.claimDue(h.clock.now(), "run-1", MINUTE);
      const saved = await s.publications.save({ ...p, leaseOwner: "intruder", status: "container_created" }, "run-1");
      expect(saved.ok && saved.value.leaseOwner).toBe("run-1");
      await s.publications.release(p.id, "someone-else");
      expect((await s.publications.get(p.id))?.leaseOwner).toBe("run-1");
      await s.publications.release(p.id, "run-1");
      const released = await s.publications.get(p.id);
      expect(released).not.toHaveProperty("leaseOwner");
      expect(released).not.toHaveProperty("leaseExpiresAt");
    });

    it("count and order published posts", async () => {
      expect(await s.publications.lastPublishedAt()).toBeUndefined();
      const p = await setup();
      await s.publications.claimDue(h.clock.now(), "run-1", 5 * MINUTE);
      const publishedAt = h.clock.now();
      await s.publications.save(
        { ...p, status: "published", mediaId: "17900000000000001", publishedAt: iso(publishedAt), permalink: "https://www.instagram.com/p/x/" },
        "run-1",
      );
      expect(await s.publications.countPublishedSince(new Date(publishedAt.getTime() - MINUTE))).toBe(1);
      expect(await s.publications.countPublishedSince(new Date(publishedAt.getTime() + 1))).toBe(0);
      expect((await s.publications.lastPublishedAt())?.toISOString()).toBe(publishedAt.toISOString());
      expect((await s.publications.listByStatus("published")).map((x) => x.id)).toEqual([p.id]);
      expect(await s.publications.listByStatus("pending")).toEqual([]);
    });

    it("record attempts", async () => {
      const p = await setup();
      await expect(
        s.publications.recordAttempt({
          publicationId: p.id,
          step: "create_container",
          outcome: "error",
          httpStatus: 400,
          errorCode: 9004,
          errorSubcode: 2207052,
          isTransient: false,
          detail: "media fetch failed",
          at: IsoDateTimeSchema.parse(h.clock.now().toISOString()),
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe("operations", () => {
    it("track job runs and errors", async () => {
      const id = await s.jobRuns.start("collect", "123", "abc");
      await s.jobRuns.recordError({ jobRunId: id, stage: "fetch", errorClass: "HttpError", message: "503", retryable: true });
      await expect(s.jobRuns.finish(id, "succeeded", { fetched: 3 })).resolves.toBeUndefined();
    });

    it("round-trip Instagram credentials", async () => {
      expect(await s.tokens.getInstagram()).toBeUndefined();
      const credentials = {
        igUserId: "17841400000000000",
        accessToken: "IGAAexample",
        obtainedAt: iso(h.clock.now()),
        expiresAt: iso(new Date(h.clock.now().getTime() + 60 * 24 * 60 * MINUTE)),
      };
      await s.tokens.saveInstagram(credentials);
      expect(await s.tokens.getInstagram()).toEqual(credentials);
      const refreshed = { ...credentials, accessToken: "IGAArefreshed" };
      await s.tokens.saveInstagram(refreshed);
      expect(await s.tokens.getInstagram()).toEqual(refreshed);
    });
  });
});
