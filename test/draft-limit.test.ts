import { describe, expect, it } from "vitest";
import { MAX_NEW_ISSUES_PER_RUN, runDrafts, type DraftDeps } from "../src/app/draft.ts";
import type { IssueRef, IssuesClient } from "../src/github/issues.ts";
import { ok } from "../src/lib/result.ts";
import { testClock } from "./support/clock.ts";
import type { StoryId } from "../src/domain/types.ts";
import { makeStory, testSource } from "./support/fixtures.ts";
import { createMemoryStores } from "./support/memory-stores.ts";

const MINUTE = 60_000;

const setup = () => {
  const clock = testClock();
  const stores = createMemoryStores(clock);
  const created: IssueRef[] = [];
  const issues: Pick<IssuesClient, "create" | "updateBody" | "comment" | "findByMarker"> = {
    create: (title, body) => {
      const ref: IssueRef = { number: created.length + 1, title, body, state: "open" };
      created.push(ref);
      return Promise.resolve(ok(ref));
    },
    updateBody: () => Promise.resolve(ok(undefined)),
    comment: () => Promise.resolve(ok(undefined)),
    findByMarker: () => Promise.resolve(ok(undefined)),
  };
  const source = testSource();
  const deps: DraftDeps = {
    stores,
    clock,
    sourceFor: (id) => (id === source.id ? source : undefined),
    objects: { put: () => Promise.resolve(), publicUrl: (key) => Promise.resolve(`https://storage.example/${key}`) },
    issues,
    renderer: () => Promise.reject(new Error("no card is rendered without a caption")),
  };
  return { clock, stores, created, deps };
};

describe("runDrafts issue limit", () => {
  it("opens at most MAX_NEW_ISSUES_PER_RUN issues a run, highest priority and newest first, and the rest next run", async () => {
    const { clock, stores, created, deps } = setup();
    const total = MAX_NEW_ISSUES_PER_RUN + 3;
    const ids: StoryId[] = [];
    for (let i = 0; i < total; i += 1) {
      clock.advance(MINUTE);
      // The oldest story is a power cut with the highest priority; the others are ordinary, newest last.
      const story = makeStory(clock.now(), { status: "awaiting_caption", priority: i === 0 ? 10 : 1, topic: i === 0 ? "power_cut" : "civic" });
      await stores.stories.insert(story);
      ids.push(story.id);
    }

    const first = await runDrafts(deps);
    expect(first).toMatchObject({ issuesCreated: MAX_NEW_ISSUES_PER_RUN, deferred: 3 });
    const opened = [...(await Promise.all(ids.map(async (id) => [id, await stores.reviewThreads.getIssueNumber(id)] as const)))];
    const withIssue = opened.filter(([, n]) => n !== undefined).map(([id]) => id);
    expect(withIssue).toContain(ids[0]); // the power cut, although it is the oldest
    expect(withIssue).not.toContain(ids[1]); // the oldest ordinary stories wait
    expect(withIssue).toContain(ids[total - 1]);

    const second = await runDrafts(deps);
    expect(second).toMatchObject({ issuesCreated: 3, deferred: 0 });
    expect(created).toHaveLength(total);
  });
});
