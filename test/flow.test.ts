import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runCollect } from "../src/app/collect.ts";
import { runDrafts, pendingDraftWork, type DraftDeps } from "../src/app/draft.ts";
import { createContentChecker } from "../src/app/publish.ts";
import { handleComment, type CommentInput } from "../src/app/review.ts";
import { runTriage } from "../src/app/triage.ts";
import { loadEnv } from "../src/config/env.ts";
import { SOURCES } from "../src/config/sources.ts";
import { SourceIdSchema, type Sha256Hex, type Source } from "../src/domain/types.ts";
import type { IssueRef, IssuesClient } from "../src/github/issues.ts";
import { renderObjectKey, type Renderer } from "../src/graphics/render.ts";
import { ok } from "../src/lib/result.ts";
import type { InstagramClient } from "../src/publishing/instagram-client.ts";
import { publishOne } from "../src/publishing/publisher.ts";
import { shortHash } from "../src/review/revision-hash.ts";
import { syncSources } from "../src/sheet/stores.ts";
import { testClock } from "./support/clock.ts";
import { iso, newSourceItem, testSource } from "./support/fixtures.ts";
import { createMemoryStores } from "./support/memory-stores.ts";
import { freshSheet } from "./support/sheet.ts";

const official = testSource({ id: SourceIdSchema.parse("test-tnpdcl"), name: "TNPDCL Erode (test)", trustTier: "T1_official" });
const paper = testSource({ id: SourceIdSchema.parse("test-paper"), name: "Test paper", trustTier: "T2_established_publisher", erodeSpecific: false });
const sources: readonly Source[] = [official, paper];
const sourceFor = (id: string): Source | undefined => sources.find((s) => s.id === id);

const fakeIssues = () => {
  const issues = new Map<number, IssueRef>();
  const comments: string[] = [];
  const client: Pick<IssuesClient, "create" | "update" | "comment" | "findByMarker"> = {
    create: (title, body) => {
      const ref: IssueRef = { number: issues.size + 1, title, body, state: "open" };
      issues.set(ref.number, ref);
      return Promise.resolve(ok(ref));
    },
    update: (n, title, body) => {
      const existing = issues.get(n);
      if (existing !== undefined) issues.set(n, { ...existing, title, body });
      return Promise.resolve(ok(undefined));
    },
    comment: (_n, body) => {
      comments.push(body);
      return Promise.resolve(ok(undefined));
    },
    findByMarker: () => Promise.resolve(ok(undefined)),
  };
  return { issues, comments, client };
};

/** Stands in for Chromium: deterministic bytes per card. */
const fakeRenderer: Renderer = {
  render: (input, now) => {
    const jpeg = new TextEncoder().encode(JSON.stringify(input));
    const jpegSha256 = createHash("sha256").update(jpeg).digest("hex") as Sha256Hex;
    return Promise.resolve(ok({ jpeg, jpegSha256, objectKey: renderObjectKey(input, now), width: 1080, height: 1350, headlinePx: 72 }));
  },
  close: () => Promise.resolve(),
};

const noWriteInstagram: InstagramClient = {
  createImageContainer: () => Promise.reject(new Error("dry run must not create containers")),
  getContainerStatus: () => Promise.reject(new Error("unexpected")),
  publishContainer: () => Promise.reject(new Error("dry run must not publish")),
  getPermalink: () => Promise.reject(new Error("unexpected")),
  getPublishingLimit: () => Promise.resolve(ok({ quotaUsage: 0, quotaTotal: 100 })),
  listRecentMedia: () => Promise.resolve(ok([])),
  refreshToken: () => Promise.reject(new Error("unexpected")),
};

describe("Erode flow, Coimbatore 360 pattern with an editor in the loop", () => {
  it("collect is refused while the Sheet switch is off, and only owner-approved sources are fetched", async () => {
    const clock = testClock();
    const stores = createMemoryStores(clock);
    const off = await runCollect({ ...stores, settings: stores.settings, clock, contactUrl: "https://example.org", sources: SOURCES });
    expect(off.status).toBe("switched_off");

    await stores.settings.setSwitch("collecting_enabled", true, "kailash075", "test");
    const fetchedHosts = new Set<string>();
    const report = await runCollect({
      ...stores,
      clock,
      contactUrl: "https://example.org",
      sources: SOURCES,
      fetch: (input) => {
        fetchedHosts.add(new URL(input).host);
        return Promise.resolve(new Response("", { status: 500 }));
      },
    });
    expect(report.status).toBe("done");
    const approvedHosts = new Set(SOURCES.filter((s) => s.termsReview.status === "approved" && s.kind !== "editor_tip").map((s) => new URL(s.url).host));
    expect(fetchedHosts.size).toBeGreaterThan(0);
    for (const host of fetchedHosts) expect(approvedHosts.has(host), host).toBe(true);
  });

  const start = new Date("2026-10-30T04:30:00Z"); // 10:00 IST
  const backends = [
    [
      "memory stores",
      () => {
        const clock = testClock(start);
        return Promise.resolve({ clock, stores: createMemoryStores(clock) });
      },
    ],
    [
      "the Google Sheet through the real bridge code",
      async () => {
        const t = await freshSheet({ start });
        await syncSources(t.bridge, sources, t.clock);
        return { clock: t.clock, stores: t.stores };
      },
    ],
  ] as const;

  it.each(backends)("goes from collected items to an approved, dry-run-publishable story (%s)", async (_name, open) => {
    const { clock, stores } = await open();
    const now = clock.now();

    // Two outlets report the same Perundurai power cut; a third item is only about Tiruppur.
    const text = "பெருந்துறை பகுதியில் நாளை காலை 9 மணி முதல் மாலை 5 மணி வரை மின் தடை";
    await stores.sourceItems.insertIfNew(newSourceItem("a", now, { sourceId: official.id, title: text, publishedAt: iso(now) }));
    await stores.sourceItems.insertIfNew(newSourceItem("b", now, { sourceId: paper.id, title: `${text} அறிவிப்பு`, publishedAt: iso(now) }));
    await stores.sourceItems.insertIfNew(newSourceItem("c", now, { sourceId: paper.id, title: "திருப்பூர் பகுதியில் நாளை மின் தடை", publishedAt: iso(now) }));

    const triage = await runTriage({ stores, clock, maxAgeHours: 36, sourceFor });
    expect(triage).toMatchObject({ items: 3, newStories: 1, attached: 1, discarded: 1 });
    const [story] = await stores.stories.listByStatus(["awaiting_caption"], 10);
    if (story === undefined) throw new Error("no story");
    expect(story.topic).toBe("power_cut");
    expect(story.riskTier).toBe("R0_ROUTINE");
    expect((await stores.evidence.listFor(story.id)).map((e) => e.kind).sort()).toEqual(["independent_corroboration", "official_source"]);

    const objects = new Map<string, Uint8Array>();
    const gh = fakeIssues();
    const deps: DraftDeps = {
      stores,
      clock,
      sourceFor,
      objects: {
        put: (key, bytes) => {
          objects.set(key, bytes);
          return Promise.resolve();
        },
        publicUrl: (key) => Promise.resolve(`https://storage.example/${key}`),
      },
      issues: gh.client,
      renderer: () => Promise.resolve(fakeRenderer),
    };

    // First draft run: the review issue asks the editor for a caption.
    expect(await pendingDraftWork({ stores })).toBe(1);
    const first = await runDrafts(deps);
    expect(first).toMatchObject({ revisions: 0, issuesCreated: 1 });
    expect(gh.issues.get(1)?.body).toContain("/caption");
    expect(await pendingDraftWork({ stores })).toBe(0);

    const env = loadEnv({ EDITOR_GITHUB_LOGINS: "kailash075", OWNER_GITHUB_LOGIN: "kailash075" });
    let commentId = 500;
    const say = (body: string) => {
      commentId += 1;
      const input: CommentInput = { body, commentId, author: "kailash075", authorAssociation: "OWNER", issueNumber: 1 };
      return handleComment({ env, stores, clock, dispatch: () => Promise.resolve(ok(undefined)) }, input);
    };

    clock.advance(60_000);
    await say(
      [
        "/caption",
        "பெருந்துறை பகுதியில் நாளை மின் தடை",
        "நாளை காலை 9 மணி முதல் மாலை 5 மணி வரை மின் விநியோகம் நிறுத்தப்படும் என்று மின் பகிர்மானக் கழகம் அறிவித்துள்ளது.",
        "பாதிக்கப்படும் பகுதிகள்: சிப்காட், விஜயமங்கலம்.",
      ].join("\n"),
    );
    clock.advance(60_000);
    const second = await runDrafts(deps);
    expect(second).toMatchObject({ revisions: 1, issuesUpdated: 1, problems: [] });
    const draft = await stores.drafts.latestFor(story.id);
    if (draft === undefined) throw new Error("no draft");
    expect(draft.captionTa).toContain("பெருந்துறை");
    expect(draft.sourceCreditTa).toBe("தகவல்: TNPDCL Erode (test), Test paper");
    expect((await stores.stories.get(story.id))?.status).toBe("in_review");

    const approval = await say(`/approve ${shortHash(draft.revisionHash)}`);
    expect(approval.reply).toContain("approved");

    // Publisher dry run: every blocking gate passes, Instagram's write endpoints are never called.
    const outcome = await publishOne({
      env,
      stores,
      objects: { publicUrl: (key) => Promise.resolve(`https://storage.example/${key}`) },
      createClient: () => noWriteInstagram,
      checkContent: createContentChecker({ stores, objects: { get: (key) => Promise.resolve(objects.get(key)) }, clock }),
      clock,
      sleep: () => Promise.resolve(),
      leaseOwner: "test-run",
    });
    expect(outcome.kind).toBe("would_publish");
  });
});
