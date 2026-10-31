import { describe, expect, it } from "vitest";
import { pendingDraftWork, runDrafts, type DraftDeps } from "../src/app/draft.ts";
import type { EditorialDecision, Story } from "../src/domain/types.ts";
import type { IssueRef } from "../src/github/issues.ts";
import { err, ok } from "../src/lib/result.ts";
import { toIso } from "../src/publishing/ist.ts";
import { expiryNote, REVIEW_TTL_HOURS, reviewExpiry } from "../src/review/expiry.ts";
import { testClock } from "./support/clock.ts";
import { makeStory, testSource } from "./support/fixtures.ts";
import { createMemoryStores } from "./support/memory-stores.ts";

const HOUR = 3_600_000;
const start = new Date("2026-10-30T04:30:00Z"); // 10:00 IST
const at = (hours: number): Date => new Date(start.getTime() + hours * HOUR);
const command = (hours: number): Pick<EditorialDecision, "createdAt"> => ({ createdAt: toIso(at(hours)) });
const story = (overrides: Partial<Story> = {}): Story => makeStory(start, { status: "in_review", ...overrides });

describe("review expiry rule", () => {
  it("expires a story 48 hours after it arrived when no editor approved it", () => {
    expect(REVIEW_TTL_HOURS).toBe(48);
    expect(reviewExpiry(story(), [], at(47.9))).toBeUndefined();
    expect(reviewExpiry(story(), [], at(48))).toBe("no_approval");
    expect(reviewExpiry(story({ status: "awaiting_caption" }), [], at(49))).toBe("no_approval");
    expect(reviewExpiry(story({ status: "on_hold" }), [], at(49))).toBe("no_approval");
  });

  it("starts the 48 hours again with each editor command", () => {
    expect(reviewExpiry(story(), [command(1), command(40)], at(87))).toBeUndefined();
    expect(reviewExpiry(story(), [command(40), command(1)], at(88))).toBe("no_approval");
  });

  it("expires a notice once its day is over, whatever the editor did", () => {
    const notice = story({ expiresAt: toIso(at(13)) });
    expect(reviewExpiry(notice, [], at(13))).toBeUndefined();
    expect(reviewExpiry(notice, [command(12.9)], at(13.1))).toBe("notice_passed");
  });

  it("leaves approved, published and finished stories alone", () => {
    for (const status of ["approved", "scheduled", "published", "rejected", "discarded", "expired"] as const) {
      expect(reviewExpiry(story({ status, expiresAt: toIso(at(1)) }), [], at(100)), status).toBeUndefined();
    }
  });

  it("explains itself on the issue", () => {
    expect(expiryNote("no_approval", story())).toContain("not approved within 48 hours");
    expect(expiryNote("no_approval", story())).toContain("/caption");
    expect(expiryNote("notice_passed", story({ expiresAt: toIso(new Date("2026-10-31T18:29:59.999Z")) }))).toContain("31.10.2026");
  });
});

const setup = () => {
  const clock = testClock(start);
  const stores = createMemoryStores(clock);
  const issues = new Map<number, IssueRef>();
  const comments: { issue: number; body: string }[] = [];
  const closed: { issue: number; reason: string }[] = [];
  let closeFails = false;
  const client: DraftDeps["issues"] = {
    create: (title, body) => {
      const ref: IssueRef = { number: 100 + issues.size, title, body, state: "open" };
      issues.set(ref.number, ref);
      return Promise.resolve(ok(ref));
    },
    update: (n, title, body) => {
      const existing = issues.get(n);
      if (existing !== undefined) issues.set(n, { ...existing, title, body });
      return Promise.resolve(ok(undefined));
    },
    comment: (issue, body) => {
      comments.push({ issue, body });
      return Promise.resolve(ok(undefined));
    },
    close: (issue, reason) => {
      if (closeFails) return Promise.resolve(err("GitHub PATCH /issues -> HTTP 502"));
      closed.push({ issue, reason });
      return Promise.resolve(ok(undefined));
    },
    findByMarker: () => Promise.resolve(ok(undefined)),
  };
  const source = testSource();
  const deps: DraftDeps = {
    stores,
    clock,
    sourceFor: (id) => (id === source.id ? source : undefined),
    objects: { put: () => Promise.resolve(), publicUrl: (key) => Promise.resolve(`https://storage.example/${key}`) },
    issues: client,
    renderer: () => Promise.reject(new Error("no card is rendered without a caption")),
  };
  const open = async (overrides: Partial<Story> = {}, issue?: number): Promise<Story> => {
    const s = makeStory(clock.now(), { status: "awaiting_caption", ...overrides });
    await stores.stories.insert(s);
    if (issue !== undefined) await stores.reviewThreads.save(s.id, issue, 0);
    return s;
  };
  return { clock, stores, deps, comments, closed, failClose: () => (closeFails = true), open };
};

describe("draft runs expire stories that waited too long", () => {
  it("expires an old story, notes why on its issue and closes it as not planned, and leaves fresh stories open", async () => {
    const t = setup();
    const old = await t.open({}, 7);
    t.clock.advance(30 * HOUR);
    const fresh = await t.open({}, 8);
    t.clock.advance(19 * HOUR);

    const report = await runDrafts(t.deps);
    expect(report).toMatchObject({ expired: 1, issuesCreated: 0, issuesUpdated: 0, problems: [] });
    expect((await t.stores.stories.get(old.id))?.status).toBe("expired");
    expect((await t.stores.stories.get(fresh.id))?.status).toBe("awaiting_caption");
    expect(t.comments).toEqual([{ issue: 7, body: expect.stringContaining("not approved within 48 hours") as unknown }]);
    expect(t.closed).toEqual([{ issue: 7, reason: "not_planned" }]);

    // Nothing is left to do for the expired story: no second note, no new issue.
    expect(await runDrafts(t.deps)).toMatchObject({ expired: 0, issuesCreated: 0 });
    expect(t.closed).toHaveLength(1);
  });

  it("expires held stories and notices whose day is over", async () => {
    const t = setup();
    const held = await t.open({ status: "on_hold" }, 3);
    t.clock.advance(2 * HOUR);
    const notice = await t.open({ status: "in_review", topic: "power_cut", expiresAt: toIso(t.clock.now()) }, 4);
    t.clock.advance(47 * HOUR);

    expect(await runDrafts(t.deps)).toMatchObject({ expired: 2 });
    expect((await t.stores.stories.get(held.id))?.status).toBe("expired");
    expect((await t.stores.stories.get(notice.id))?.status).toBe("expired");
    expect(t.comments.find((c) => c.issue === 4)?.body).toContain("that day is over");
  });

  it("the cheap check expires stories itself, so it does not start the Chromium job for them", async () => {
    const t = setup();
    await t.open(); // never got an issue: without expiry it would count as work
    t.clock.advance(49 * HOUR);
    expect(await pendingDraftWork(t.deps)).toEqual({ pending: 0, expired: 1, problems: [] });
    expect(t.comments).toHaveLength(0);
    expect(await runDrafts(t.deps)).toMatchObject({ expired: 0, issuesCreated: 0 });
  });

  it("reports an issue GitHub would not close, and the story stays expired", async () => {
    const t = setup();
    const old = await t.open({}, 5);
    t.clock.advance(49 * HOUR);
    t.failClose();
    const report = await runDrafts(t.deps);
    expect(report.expired).toBe(1);
    expect(report.problems).toEqual([expect.stringContaining("issue #5 was not closed") as unknown]);
    expect((await t.stores.stories.get(old.id))?.status).toBe("expired");
  });

  it("leaves a story that changed meanwhile for the next run", async () => {
    const t = setup();
    const old = await t.open({}, 6);
    t.clock.advance(49 * HOUR);
    const deps: DraftDeps = {
      ...t.deps,
      stores: {
        ...t.stores,
        stories: { ...t.stores.stories, updateMany: (changes) => Promise.resolve(changes.map(() => err("version_conflict" as const))) },
      },
    };
    expect(await runDrafts(deps)).toMatchObject({ expired: 0, issuesUpdated: 0 });
    expect(t.closed).toHaveLength(0);
    expect((await t.stores.stories.get(old.id))?.status).toBe("awaiting_caption");
  });
});
