import { randomUUID } from "node:crypto";
import type {
  DecisionStore,
  DraftStore,
  EvidenceStore,
  InstagramCredentials,
  PublicationStore,
  PublishAttempt,
  SettingsStore,
  StoryStore,
  SwitchKey,
  SwitchState,
  TokenStore,
} from "../../src/domain/ports.ts";
import {
  DraftIdSchema,
  GitHubLoginSchema,
  PublicationIdSchema,
  SourceItemIdSchema,
  StoryIdSchema,
  type DraftRevision,
  type EditorialDecision,
  type Publication,
  type PublicationId,
  type Story,
  type StoryId,
  type VerificationEvidence,
} from "../../src/domain/types.ts";
import { err, ok } from "../../src/lib/result.ts";
import { createInstagramClient, type FetchFn } from "../../src/publishing/instagram-client.ts";
import { toIso } from "../../src/publishing/ist.ts";
import { newPublication, type PublisherDeps, type PublisherEnv, type ReconcileDeps } from "../../src/publishing/publisher.ts";
import { revisionHash, sha256Hex } from "../../src/review/revision-hash.ts";
import fixtures from "./fixtures/meta-responses.json" with { type: "json" };

export { fixtures };

export const EDITOR = GitHubLoginSchema.parse("kailash075");
export const TOKEN = "IGAAsecretsecretsecretsecretsecretsecretsecretsecret123";
export const IG_USER_ID = "17841400000000000";
/** 12:00 IST on 30 Oct 2026: inside the 08:00 to 21:00 posting window. */
export const NOON_IST = new Date("2026-10-30T06:30:00Z");

export const env = (overrides: Partial<PublisherEnv> = {}): PublisherEnv => ({
  DRY_RUN: false,
  PAUSED: false,
  POSTING_WINDOW_IST: { startMinute: 8 * 60, endMinute: 21 * 60 },
  MAX_POSTS_PER_DAY: 6,
  MIN_MINUTES_BETWEEN_POSTS: 30,
  APPROVAL_TTL_HOURS: 12,
  EDITOR_GITHUB_LOGINS: [EDITOR],
  ...overrides,
});

export const mutableClock = (start: Date): { now: () => Date; advance: (ms: number) => void; set: (d: Date) => void } => {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current = new Date(current.getTime() + ms);
    },
    set: (d) => {
      current = d;
    },
  };
};

// ---------------------------------------------------------------- builders

export const makeStory = (overrides: Partial<Story> = {}): Story => ({
  id: StoryIdSchema.parse(randomUUID()),
  status: "approved",
  version: 3,
  topic: "power_cut",
  placeTags: ["ஈரோடு"],
  riskTier: "R0_ROUTINE",
  riskFlags: [],
  disputed: false,
  priority: 10,
  firstSeenAt: toIso(new Date("2026-10-30T02:00:00Z")),
  updatedAt: toIso(new Date("2026-10-30T05:00:00Z")),
  ...overrides,
});

export const RENDER_SHA = sha256Hex("rendered jpeg bytes");

export const makeDraft = (story: Story, overrides: Partial<Omit<DraftRevision, "revisionHash">> = {}): DraftRevision => {
  const base = {
    id: DraftIdSchema.parse(randomUUID()),
    storyId: story.id,
    revision: 1,
    headlineTa: "ஈரோட்டில் நாளை மின் தடை",
    captionTa: "ஈரோடு நகரின் சில பகுதிகளில் நாளை காலை 9 மணி முதல் மாலை 5 மணி வரை மின் தடை.",
    hashtags: ["#ஈரோடு", "#Erode", "#ErodeGlitz"],
    altText: "மின் தடை அறிவிப்பு அட்டை",
    sourceCreditTa: "தகவல்: மின்வாரியம்",
    templateVersion: "news-card@1",
    renderKey: "renders/2026/10/abc.jpg",
    renderSha256: RENDER_SHA,
    origin: "template" as const,
    createdAt: toIso(new Date("2026-10-30T05:00:00Z")),
    ...overrides,
  };
  const hash = revisionHash({
    storyId: base.storyId,
    revision: base.revision,
    headlineTa: base.headlineTa,
    captionTa: base.captionTa,
    hashtags: base.hashtags,
    altText: base.altText,
    sourceCreditTa: base.sourceCreditTa,
    templateVersion: base.templateVersion,
    renderSha256: base.renderSha256,
    sources: [{ name: "TANGEDCO", url: "https://example.org/notice" }],
  });
  return { ...base, revisionHash: hash };
};

export const withoutRender = (draft: DraftRevision): DraftRevision => {
  const copy = { ...draft };
  delete copy.renderSha256;
  delete copy.renderKey;
  return copy;
};

export const approval = (
  draft: DraftRevision,
  overrides: Partial<EditorialDecision> = {},
): EditorialDecision => ({
  storyId: draft.storyId,
  kind: "approve",
  editorLogin: EDITOR,
  githubCommentId: Math.floor(Math.random() * 1e9),
  revisionHash: draft.revisionHash,
  createdAt: toIso(new Date("2026-10-30T06:00:00Z")),
  ...overrides,
});

export const officialEvidence = (): VerificationEvidence => ({ kind: "official_source", sourceItemId: SourceItemIdSchema.parse(randomUUID()) });

export const credentials = (overrides: Partial<InstagramCredentials> = {}): InstagramCredentials => ({
  igUserId: IG_USER_ID,
  accessToken: TOKEN,
  obtainedAt: toIso(new Date("2026-10-20T00:00:00Z")),
  expiresAt: toIso(new Date("2026-12-19T00:00:00Z")),
  ...overrides,
});

// ---------------------------------------------------------------- in-memory stores

export type MemoryPublications = PublicationStore & {
  rows: Map<PublicationId, Publication>;
  attempts: PublishAttempt[];
  /** When true, every save fails as if another runner had taken the lease. */
  loseLease: boolean;
  claimById: ReconcileDeps["claimById"];
};

export const memoryPublications = (): MemoryPublications => {
  const rows = new Map<PublicationId, Publication>();
  const attempts: PublishAttempt[] = [];
  const store: MemoryPublications = {
    rows,
    attempts,
    loseLease: false,
    createIfAbsent: (p) => {
      const existing = [...rows.values()].find((r) => r.idempotencyKey === p.idempotencyKey);
      if (existing !== undefined) return Promise.resolve(existing);
      rows.set(p.id, p);
      return Promise.resolve(p);
    },
    get: (id) => Promise.resolve(rows.get(id)),
    claimDue: (now, owner, leaseMs) => {
      for (const p of rows.values()) {
        const due =
          (p.status === "pending" || p.status === "container_created") &&
          Date.parse(p.scheduledFor) <= now.getTime() &&
          (p.nextAttemptAt === undefined || Date.parse(p.nextAttemptAt) <= now.getTime());
        const free = p.leaseExpiresAt === undefined || Date.parse(p.leaseExpiresAt) <= now.getTime();
        if (due && free) {
          const claimed: Publication = { ...p, leaseOwner: owner, leaseExpiresAt: toIso(new Date(now.getTime() + leaseMs)) };
          rows.set(p.id, claimed);
          return Promise.resolve(claimed);
        }
      }
      return Promise.resolve(undefined);
    },
    claimById: (id, owner, leaseMs) => {
      const p = rows.get(id);
      if (p === undefined) return Promise.resolve(undefined);
      const claimed: Publication = { ...p, leaseOwner: owner, leaseExpiresAt: toIso(new Date(Date.now() + leaseMs)) };
      rows.set(id, claimed);
      return Promise.resolve(claimed);
    },
    save: (p, owner) => {
      const current = rows.get(p.id);
      if (store.loseLease || current?.leaseOwner !== owner) return Promise.resolve(err("lease_lost" as const));
      rows.set(p.id, p);
      return Promise.resolve(ok(p));
    },
    release: (id, owner) => {
      const current = rows.get(id);
      if (current?.leaseOwner === owner) {
        const copy = { ...current };
        delete copy.leaseOwner;
        delete copy.leaseExpiresAt;
        rows.set(id, copy);
      }
      return Promise.resolve();
    },
    countPublishedSince: (since) =>
      Promise.resolve(
        [...rows.values()].filter((p) => p.status === "published" && p.publishedAt !== undefined && Date.parse(p.publishedAt) >= since.getTime())
          .length,
      ),
    lastPublishedAt: () => {
      const times = [...rows.values()].flatMap((p) => (p.publishedAt === undefined ? [] : [Date.parse(p.publishedAt)]));
      return Promise.resolve(times.length === 0 ? undefined : new Date(Math.max(...times)));
    },
    listByStatus: (status) => Promise.resolve([...rows.values()].filter((p) => p.status === status)),
    recordAttempt: (a) => {
      attempts.push(a);
      return Promise.resolve();
    },
  };
  return store;
};

export type MemorySettings = SettingsStore & { states: Map<SwitchKey, SwitchState>; reads: number; afterReads?: (n: number) => void };

export const memorySettings = (killSwitch: boolean): MemorySettings => {
  const states = new Map<SwitchKey, SwitchState>([["kill_switch", { enabled: killSwitch, reason: "test", updatedBy: "owner" }]]);
  const s: MemorySettings = {
    states,
    reads: 0,
    getSwitch: (key) => {
      s.reads++;
      s.afterReads?.(s.reads);
      return Promise.resolve(states.get(key) ?? { enabled: false, reason: "missing", updatedBy: "nobody" });
    },
    setSwitch: (key, enabled, updatedBy, reason) => {
      states.set(key, { enabled, reason, updatedBy });
      return Promise.resolve();
    },
  };
  return s;
};

export const memoryStories = (initial: readonly Story[]): StoryStore & { rows: Map<StoryId, Story> } => {
  const rows = new Map(initial.map((s) => [s.id, s]));
  return {
    rows,
    insert: (story) => {
      rows.set(story.id, story);
      return Promise.resolve();
    },
    insertMany: (stories) => {
      for (const story of stories) rows.set(story.id, story);
      return Promise.resolve();
    },
    get: (id) => Promise.resolve(rows.get(id)),
    update: (story, expectedVersion) => {
      const current = rows.get(story.id);
      if (current === undefined) return Promise.resolve(err("not_found" as const));
      if (current.version !== expectedVersion) return Promise.resolve(err("version_conflict" as const));
      const next = { ...story, version: expectedVersion + 1 };
      rows.set(story.id, next);
      return Promise.resolve(ok(next));
    },
    listByStatus: (statuses, limit) => Promise.resolve([...rows.values()].filter((s) => statuses.includes(s.status)).slice(0, limit)),
    listRecentWithItems: () => Promise.resolve([]),
  };
};

/** The `...ForStories` answer: only stories with entries. */
const perStory = <T>(storyIds: readonly StoryId[], list: (storyId: StoryId) => T | undefined): ReadonlyMap<StoryId, T> =>
  new Map(storyIds.flatMap((id) => {
    const entry = list(id);
    return entry === undefined ? [] : [[id, entry] as const];
  }));

const nonEmpty = <T>(list: readonly T[]): readonly T[] | undefined => (list.length === 0 ? undefined : list);

export const memoryDrafts = (initial: readonly DraftRevision[]): DraftStore => {
  const rows = [...initial];
  const latest = (storyId: StoryId) => rows.filter((d) => d.storyId === storyId).sort((a, b) => b.revision - a.revision)[0];
  return {
    insert: (d) => {
      rows.push(d);
      return Promise.resolve();
    },
    get: (id) => Promise.resolve(rows.find((d) => d.id === id)),
    latestFor: (storyId) => Promise.resolve(latest(storyId)),
    latestForStories: (storyIds) => Promise.resolve(perStory(storyIds, latest)),
  };
};

export const memoryDecisions = (initial: readonly EditorialDecision[]): DecisionStore => {
  const rows = [...initial];
  return {
    record: (d) => {
      if (rows.some((r) => r.githubCommentId === d.githubCommentId)) return Promise.resolve({ recorded: false });
      rows.push(d);
      return Promise.resolve({ recorded: true });
    },
    listFor: (storyId) => Promise.resolve(rows.filter((d) => d.storyId === storyId)),
    listForStories: (storyIds) => Promise.resolve(perStory(storyIds, (id) => nonEmpty(rows.filter((d) => d.storyId === id)))),
  };
};

export const memoryEvidence = (byStory: ReadonlyMap<StoryId, readonly VerificationEvidence[]>): EvidenceStore => ({
  add: () => Promise.resolve(),
  listFor: (storyId) => Promise.resolve(byStory.get(storyId) ?? []),
  listForStories: (storyIds) => Promise.resolve(perStory(storyIds, (id) => nonEmpty(byStory.get(id) ?? []))),
});

export const memoryTokens = (initial: InstagramCredentials | undefined): TokenStore => {
  let current = initial;
  return {
    getInstagram: () => Promise.resolve(current),
    saveInstagram: (c) => {
      current = c;
      return Promise.resolve();
    },
  };
};

// ---------------------------------------------------------------- fake Meta

export type Endpoint = "create" | "status" | "publish" | "permalink" | "limit" | "media" | "refresh";

export type RecordedCall = { endpoint: Endpoint; method: string; url: string; headers: Record<string, string>; body: string | undefined };

type Handler = (call: RecordedCall) => Response | Promise<Response>;

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export const networkError = (code: string, message = "network failure"): Error =>
  Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(message), { code }) });

export type FakeMeta = {
  fetch: FetchFn;
  calls: RecordedCall[];
  handlers: Record<Endpoint, Handler>;
  writes: () => RecordedCall[];
  count: (endpoint: Endpoint) => number;
};

const endpointOf = (method: string, url: URL): Endpoint => {
  const parts = url.pathname.split("/").filter((p) => p !== "");
  if (parts[0] === "refresh_access_token") return "refresh";
  const last = parts[parts.length - 1];
  if (method === "POST" && last === "media") return "create";
  if (method === "POST" && last === "media_publish") return "publish";
  if (last === "content_publishing_limit") return "limit";
  if (last === "media") return "media";
  if (url.searchParams.get("fields")?.startsWith("status_code") === true) return "status";
  if (url.searchParams.get("fields") === "permalink") return "permalink";
  throw new Error(`unexpected request ${method} ${url.pathname}`);
};

export const fakeMeta = (): FakeMeta => {
  const calls: RecordedCall[] = [];
  const handlers: Record<Endpoint, Handler> = {
    create: () => json(fixtures.createContainer),
    status: () => json(fixtures.statusFinished),
    publish: () => json(fixtures.publish),
    permalink: () => json(fixtures.permalink),
    limit: () => json(fixtures.publishingLimit),
    media: () => json(fixtures.mediaEmpty),
    refresh: () => json(fixtures.refresh),
  };
  const fetch: FetchFn = async (input, init) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call: RecordedCall = {
      endpoint: endpointOf(method, url),
      method,
      url: input,
      headers,
      body: typeof init.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    return handlers[call.endpoint](call);
  };
  return {
    fetch,
    calls,
    handlers,
    writes: () => calls.filter((c) => c.method !== "GET"),
    count: (endpoint) => calls.filter((c) => c.endpoint === endpoint).length,
  };
};

// ---------------------------------------------------------------- a whole world

export type World = {
  deps: PublisherDeps;
  reconcileDeps: ReconcileDeps;
  meta: FakeMeta;
  publications: MemoryPublications;
  settings: MemorySettings;
  stories: ReturnType<typeof memoryStories>;
  clock: ReturnType<typeof mutableClock>;
  story: Story;
  draft: DraftRevision;
  publication: Publication;
};

export type WorldOptions = {
  env?: Partial<PublisherEnv>;
  story?: Partial<Story>;
  /** The Sheet's kill switch is on. Default: off. */
  killSwitch?: boolean;
  /** The LIVE file exists. Default: yes. */
  live?: boolean;
  token?: InstagramCredentials | undefined;
  decisions?: (draft: DraftRevision) => readonly EditorialDecision[];
  evidence?: readonly VerificationEvidence[];
  extraDrafts?: (story: Story) => readonly DraftRevision[];
  now?: Date;
};

export const world = async (options: WorldOptions = {}): Promise<World> => {
  const story = makeStory(options.story);
  const draft = makeDraft(story);
  const drafts = [draft, ...(options.extraDrafts?.(story) ?? [])];
  const publications = memoryPublications();
  const settings = memorySettings(options.killSwitch ?? false);
  const stories = memoryStories([story]);
  const clock = mutableClock(options.now ?? NOON_IST);
  const meta = fakeMeta();
  const decisions = options.decisions?.(draft) ?? [approval(draft)];
  const publication = await publications.createIfAbsent(
    newPublication({
      id: PublicationIdSchema.parse(randomUUID()),
      story,
      draft,
      scheduledFor: toIso(new Date("2026-10-30T06:00:00Z")),
      igAccount: IG_USER_ID,
    }),
  );
  const common = {
    env: env(options.env),
    live: options.live ?? true,
    stores: {
      settings,
      publications,
      tokens: memoryTokens("token" in options ? options.token : credentials()),
      stories,
      drafts: memoryDrafts(drafts),
      decisions: memoryDecisions(decisions),
      evidence: memoryEvidence(new Map([[story.id, options.evidence ?? [officialEvidence()]]])),
    },
    createClient: (accessToken: string) => createInstagramClient({ fetch: meta.fetch, accessToken, graphVersion: "v26.0" }),
    clock,
    sleep: () => Promise.resolve(),
    leaseOwner: "run-1",
  };
  const deps: PublisherDeps = {
    ...common,
    objects: { publicUrl: (key) => Promise.resolve(`https://storage.example.test/${key}`) },
    checkContent: (_story, d) =>
      Promise.resolve({
        validation: { passed: true, problems: [] },
        storedRenderSha256: d.renderSha256,
        nearDuplicate: { found: false, overriddenByEditor: false },
      }),
  };
  return {
    deps,
    reconcileDeps: { ...common, claimById: publications.claimById },
    meta,
    publications,
    settings,
    stories,
    clock,
    story,
    draft,
    publication,
  };
};
