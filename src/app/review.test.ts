import { describe, expect, it } from "vitest";
import { testClock } from "../../test/support/clock.ts";
import { makeDraft, makeStory, sha } from "../../test/support/fixtures.ts";
import { createMemoryStores } from "../../test/support/memory-stores.ts";
import { loadEnv } from "../config/env.ts";
import { uuidv7 } from "../lib/ids.ts";
import { SourceItemIdSchema, type Story } from "../domain/types.ts";
import { ok } from "../lib/result.ts";
import { shortHash } from "../review/revision-hash.ts";
import { handleComment, type CommentInput, type ReviewDeps } from "./review.ts";

const ISSUE = 41;

const setup = async (storyOverrides: Partial<Story> = {}, envOverrides: Record<string, string> = {}, officialSource = true) => {
  const clock = testClock(new Date("2026-10-30T05:00:00Z")); // 10:30 IST
  const stores = createMemoryStores(clock);
  const story = makeStory(clock.now(), { status: "in_review", ...storyOverrides });
  await stores.stories.insert(story);
  const draft = makeDraft(story.id, clock.now(), 1, { renderSha256: sha("jpeg"), renderKey: "renders/2026/10/x.jpg" });
  await stores.drafts.insert(draft);
  await stores.reviewThreads.save(story.id, ISSUE, 1);
  if (officialSource) await stores.evidence.add(story.id, { kind: "official_source", sourceItemId: SourceItemIdSchema.parse(uuidv7()) });
  const dispatched: string[] = [];
  const env = loadEnv({ EDITOR_GITHUB_LOGINS: "kailash075", OWNER_GITHUB_LOGIN: "kailash075", ...envOverrides });
  const deps: ReviewDeps = {
    env,
    stores,
    clock,
    dispatch: (workflow) => {
      dispatched.push(workflow);
      return Promise.resolve(ok(undefined));
    },
  };
  let commentId = 1000;
  const say = (body: string, author = "kailash075", association = "OWNER") => {
    commentId += 1;
    const input: CommentInput = { body, commentId, author, authorAssociation: association, issueNumber: ISSUE };
    return handleComment(deps, input);
  };
  return { stores, story, draft, say, dispatched, clock };
};

describe("review desk", () => {
  it("approves the current revision and queues one publication", async () => {
    const t = await setup({}, { PUBLISHING_ENABLED: "true", PUBLISH_ON_APPROVAL: "true" });
    const result = await t.say(`/approve ${shortHash(t.draft.revisionHash)}`);
    expect(result.reply).toContain("approved");
    expect((await t.stores.stories.get(t.story.id))?.status).toBe("approved");
    expect(await t.stores.publications.listByStatus("pending")).toHaveLength(1);
    expect(t.dispatched).toEqual(["publish.yml"]);
  });

  it("does not start publish.yml unless publishing and publish-on-approval are both on", async () => {
    const t = await setup();
    const result = await t.say(`/approve ${shortHash(t.draft.revisionHash)}`);
    expect(result.reply).toContain("Publishing is not enabled yet");
    expect(t.dispatched).toEqual([]);
  });

  it("refuses an approval for an older revision", async () => {
    const t = await setup();
    const result = await t.say("/approve 000000000000");
    expect(result.reply).toContain("not the current revision");
    expect(await t.stores.publications.listByStatus("pending")).toHaveLength(0);
  });

  it("requires /approve-sensitive and enough verification for a sensitive story", async () => {
    const t = await setup({ riskTier: "R2_SENSITIVE", topic: "crime" }, {}, false);
    const rev = shortHash(t.draft.revisionHash);
    expect((await t.say(`/approve ${rev}`)).reply).toContain("/approve-sensitive");
    expect((await t.say(`/approve-sensitive ${rev}`)).reply).toContain("V0_UNVERIFIED");
    await t.say("/attest Called the Erode Town police station at 10:40 IST, duty officer confirmed");
    expect((await t.say(`/approve-sensitive ${rev}`)).reply).toContain("approved");
  });

  it("stays silent for someone who is not an editor and changes nothing", async () => {
    const t = await setup();
    const result = await t.say(`/approve ${shortHash(t.draft.revisionHash)}`, "stranger", "NONE");
    expect(result.reply).toBeUndefined();
    expect((await t.stores.stories.get(t.story.id))?.status).toBe("in_review");
  });

  it("handles a redelivered comment only once", async () => {
    const t = await setup();
    const input: CommentInput = {
      body: `/approve ${shortHash(t.draft.revisionHash)}`,
      commentId: 7,
      author: "kailash075",
      authorAssociation: "OWNER",
      issueNumber: ISSUE,
    };
    const deps = { env: loadEnv({ EDITOR_GITHUB_LOGINS: "kailash075" }), stores: t.stores, clock: t.clock, dispatch: () => Promise.resolve(ok(undefined)) };
    expect((await handleComment(deps, input)).reply).toContain("approved");
    expect((await handleComment(deps, input)).reply).toBeUndefined();
  });

  it("lets an editor stop publishing and only the owner start it again", async () => {
    const t = await setup({}, { EDITOR_GITHUB_LOGINS: "kailash075,helper1" });
    await t.stores.settings.setSwitch("publishing_enabled", true, "kailash075", "live");
    expect((await t.say("/killswitch on wrong district in last post", "helper1", "COLLABORATOR")).reply).toContain("OFF");
    expect((await t.stores.settings.getSwitch("publishing_enabled")).enabled).toBe(false);
    expect((await t.say("/killswitch off", "helper1", "COLLABORATOR")).reply).toContain("Only the owner");
    expect((await t.stores.settings.getSwitch("publishing_enabled")).enabled).toBe(false);
    await t.say("/killswitch off");
    expect((await t.stores.settings.getSwitch("publishing_enabled")).enabled).toBe(true);
  });

  it("asks draft.yml for a new revision after /caption", async () => {
    const t = await setup();
    const result = await t.say("/caption\nஈரோட்டில் நாளை காலை 9 மணி முதல் மின்தடை.");
    expect(result.reply).toContain("New revision");
    expect(t.dispatched).toEqual(["draft.yml"]);
  });
});
