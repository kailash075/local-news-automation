import { err, ok } from "../../src/lib/result.ts";
import type {
  Clock,
  InstagramCredentials,
  JobRunId,
  NewSourceItem,
  PublishAttempt,
  SourceFetchState,
  StoryAttachment,
  StoryRelation,
  Stores,
  SwitchKey,
  SwitchState,
} from "../../src/domain/ports.ts";
import {
  IsoDateTimeSchema,
  SourceItemIdSchema,
  SourceItemSchema,
  VerificationEvidenceSchema,
  type DraftRevision,
  type EditorialDecision,
  type Publication,
  type SourceItem,
  type Story,
  type StoryId,
  type VerificationEvidence,
} from "../../src/domain/types.ts";
import { uuidv7 } from "../../src/lib/ids.ts";

/**
 * In-memory `Stores` with the same observable semantics as `src/db/stores.ts`, for fast unit tests of jobs.
 * The shared contract tests in test/db-contract.test.ts run against both implementations.
 * Differences: no foreign keys (source state does not need the registry mirror), no CHECK constraints, no encryption.
 */

export type MemoryStores = Stores & {
  /** Raw state, for assertions. */
  readonly state: {
    readonly attempts: readonly PublishAttempt[];
    readonly errors: readonly { jobRunId: JobRunId; stage: string; message: string }[];
    readonly jobRuns: ReadonlyMap<JobRunId, { workflow: string; status: string; counters: Readonly<Record<string, number>> }>;
  };
};

const iso = (d: Date) => IsoDateTimeSchema.parse(d.toISOString());
const time = (value: string | undefined): number => (value === undefined ? Number.NEGATIVE_INFINITY : Date.parse(value));
const clone = <T>(value: T): T => structuredClone(value);

export const createMemoryStores = (clock: Clock): MemoryStores => {
  const switches = new Map<SwitchKey, SwitchState>();
  const fetchStates = new Map<string, SourceFetchState>();
  const items = new Map<string, SourceItem>();
  const itemStory = new Map<string, StoryId>();
  const links = new Map<string, { storyId: StoryId; itemId: string; relation: StoryRelation; order: number }>();
  const storyMap = new Map<string, Story>();
  const draftMap = new Map<string, DraftRevision>();
  const evidence: { storyId: StoryId; evidence: VerificationEvidence }[] = [];
  const decisions: EditorialDecision[] = [];
  const threads = new Map<StoryId, { issueNumber: number; lastSyncedRevision: number }>();
  const pubs = new Map<string, Publication>();
  const attempts: PublishAttempt[] = [];
  const jobRuns = new Map<JobRunId, { workflow: string; status: string; counters: Readonly<Record<string, number>> }>();
  const errors: { jobRunId: JobRunId; stage: string; message: string }[] = [];
  let token: InstagramCredentials | undefined;
  let linkOrder = 0;

  /** Map of the stories that have entries, as the Sheet stores answer the `...ForStories` reads. */
  const perStory = <T>(storyIds: readonly StoryId[], list: (storyId: StoryId) => readonly T[]): ReadonlyMap<StoryId, readonly T[]> =>
    new Map(storyIds.map((id) => [id, list(id)] as const).filter(([, entries]) => entries.length > 0));

  const insertManyIfNew = (batch: readonly NewSourceItem[]): Promise<readonly SourceItem[]> => {
    const start = clock.now().getTime();
    const stored: SourceItem[] = [];
    for (const item of batch) {
      if ([...items.values()].some((i) => i.sourceId === item.sourceId && i.urlHash === item.urlHash)) continue;
      const next = SourceItemSchema.parse({ ...item, id: SourceItemIdSchema.parse(uuidv7(new Date(start + stored.length))) });
      items.set(next.id, next);
      stored.push(clone(next));
    }
    return Promise.resolve(stored);
  };

  const attachToStories = (attachments: readonly StoryAttachment[]): Promise<void> => {
    for (const { itemId, storyId, relation } of attachments) {
      const key = `${storyId}:${itemId}`;
      const existing = links.get(key);
      links.set(key, { storyId, itemId, relation, order: existing?.order ?? linkOrder++ });
      if (!itemStory.has(itemId)) itemStory.set(itemId, storyId);
    }
    return Promise.resolve();
  };

  const latestDraft = (storyId: StoryId): DraftRevision | undefined =>
    [...draftMap.values()].filter((d) => d.storyId === storyId).sort((a, b) => b.revision - a.revision)[0];

  const decisionsFor = (storyId: StoryId): EditorialDecision[] =>
    decisions
      .filter((d) => d.storyId === storyId)
      .sort((a, b) => time(a.createdAt) - time(b.createdAt))
      .map(clone);

  const evidenceFor = (storyId: StoryId): VerificationEvidence[] => evidence.filter((e) => e.storyId === storyId).map((e) => clone(e.evidence));

  const itemsForStory = (storyId: StoryId): SourceItem[] =>
    [...links.values()]
      .filter((l) => l.storyId === storyId)
      .map((l) => items.get(l.itemId))
      .filter((i): i is SourceItem => i !== undefined)
      .sort((a, b) => time(a.fetchedAt) - time(b.fetchedAt) || a.id.localeCompare(b.id))
      .map(clone);

  const leaseFree = (p: Publication, now: Date): boolean => p.leaseExpiresAt === undefined || time(p.leaseExpiresAt) <= now.getTime();
  const isLive = (p: Publication): boolean => p.status !== "cancelled" && p.status !== "publish_failed";
  const withoutLease = (p: Publication): Publication => {
    const copy = clone(p);
    delete copy.leaseOwner;
    delete copy.leaseExpiresAt;
    return copy;
  };

  return {
    state: { attempts, errors, jobRuns },

    settings: {
      getSwitch: (key) => Promise.resolve(clone(switches.get(key) ?? { enabled: false, reason: "not set", updatedBy: "system" })),
      setSwitch: (key, enabled, updatedBy, reason) => {
        switches.set(key, { enabled, reason, updatedBy, updatedAt: iso(clock.now()) });
        return Promise.resolve();
      },
    },

    sourceState: {
      getFetchState: (sourceId) => Promise.resolve(clone(fetchStates.get(sourceId) ?? { sourceId, consecutiveFailures: 0 })),
      saveFetchState: (state) => {
        fetchStates.set(state.sourceId, clone(state));
        return Promise.resolve();
      },
    },

    sourceItems: {
      insertIfNew: async (item: NewSourceItem) => {
        const [stored] = await insertManyIfNew([item]);
        return stored === undefined ? ({ inserted: false } as const) : ({ inserted: true, item: stored } as const);
      },
      insertManyIfNew,
      isKnown: (sourceId, urlHash) => Promise.resolve([...items.values()].some((i) => i.sourceId === sourceId && i.urlHash === urlHash)),
      listUnassigned: (limit) =>
        Promise.resolve(
          [...items.values()]
            .filter((i) => !itemStory.has(i.id))
            .sort((a, b) => time(a.fetchedAt) - time(b.fetchedAt) || a.id.localeCompare(b.id))
            .slice(0, limit)
            .map(clone),
        ),
      attachToStory: (itemId, storyId, relation) => attachToStories([{ itemId, storyId, relation }]),
      attachToStories,
      listForStory: (storyId) => Promise.resolve(itemsForStory(storyId)),
      listForStories: (storyIds) => Promise.resolve(perStory(storyIds, itemsForStory)),
    },

    stories: {
      insert: (story) => {
        if (storyMap.has(story.id)) return Promise.reject(new Error(`duplicate story id ${story.id}`));
        storyMap.set(story.id, clone(story));
        return Promise.resolve();
      },
      insertMany: (stories) => {
        const clash = stories.find((story, i) => storyMap.has(story.id) || stories.findIndex((other) => other.id === story.id) !== i);
        if (clash !== undefined) return Promise.reject(new Error(`duplicate story id ${clash.id}`));
        for (const story of stories) storyMap.set(story.id, clone(story));
        return Promise.resolve();
      },
      get: (id) => Promise.resolve(storyMap.has(id) ? clone(storyMap.get(id)) : undefined),
      update: (story, expectedVersion) => {
        const current = storyMap.get(story.id);
        if (current === undefined) return Promise.resolve(err("not_found" as const));
        if (current.version !== expectedVersion) return Promise.resolve(err("version_conflict" as const));
        const next: Story = { ...clone(story), firstSeenAt: current.firstSeenAt, version: expectedVersion + 1 };
        storyMap.set(story.id, next);
        return Promise.resolve(ok(clone(next)));
      },
      listByStatus: (statuses, limit) =>
        Promise.resolve(
          [...storyMap.values()]
            .filter((s) => statuses.includes(s.status))
            .sort((a, b) => b.priority - a.priority || time(a.firstSeenAt) - time(b.firstSeenAt) || a.id.localeCompare(b.id))
            .slice(0, limit)
            .map(clone),
        ),
      listRecentWithItems: (since) =>
        Promise.resolve(
          [...storyMap.values()]
            .filter((s) => time(s.firstSeenAt) >= time(since))
            .sort((a, b) => time(a.firstSeenAt) - time(b.firstSeenAt) || a.id.localeCompare(b.id))
            .map((s) => ({ story: clone(s), items: itemsForStory(s.id) })),
        ),
    },

    drafts: {
      insert: (d) => {
        const clash = [...draftMap.values()].some(
          (x) => x.id === d.id || x.revisionHash === d.revisionHash || (x.storyId === d.storyId && x.revision === d.revision),
        );
        if (clash) return Promise.reject(new Error("unique violation on drafts"));
        draftMap.set(d.id, clone(d));
        return Promise.resolve();
      },
      get: (id) => Promise.resolve(draftMap.has(id) ? clone(draftMap.get(id)) : undefined),
      latestFor: (storyId) => {
        const latest = latestDraft(storyId);
        return Promise.resolve(latest === undefined ? undefined : clone(latest));
      },
      latestForStories: (storyIds) => {
        const latest = new Map<StoryId, DraftRevision>();
        for (const id of storyIds) {
          const draft = latestDraft(id);
          if (draft !== undefined) latest.set(id, clone(draft));
        }
        return Promise.resolve(latest);
      },
    },

    evidence: {
      add: (storyId, e) => {
        evidence.push({ storyId, evidence: VerificationEvidenceSchema.parse(e) });
        return Promise.resolve();
      },
      listFor: (storyId) => Promise.resolve(evidenceFor(storyId)),
      listForStories: (storyIds) => Promise.resolve(perStory(storyIds, evidenceFor)),
    },

    decisions: {
      record: (d) => {
        if (decisions.some((x) => x.githubCommentId === d.githubCommentId)) return Promise.resolve({ recorded: false });
        decisions.push(clone(d));
        return Promise.resolve({ recorded: true });
      },
      listFor: (storyId) => Promise.resolve(decisionsFor(storyId)),
      listForStories: (storyIds) => Promise.resolve(perStory(storyIds, decisionsFor)),
    },

    reviewThreads: {
      getIssueNumber: (storyId) => Promise.resolve(threads.get(storyId)?.issueNumber),
      issueNumbersFor: (storyIds) => {
        const numbers = new Map<StoryId, number>();
        for (const id of storyIds) {
          const thread = threads.get(id);
          if (thread !== undefined) numbers.set(id, thread.issueNumber);
        }
        return Promise.resolve(numbers);
      },
      getStoryId: (issueNumber) => {
        for (const [storyId, t] of threads) {
          if (t.issueNumber === issueNumber) return Promise.resolve(storyId);
        }
        return Promise.resolve(undefined);
      },
      save: (storyId, issueNumber, lastSyncedRevision) => {
        for (const [otherId, t] of threads) {
          if (otherId !== storyId && t.issueNumber === issueNumber) {
            return Promise.reject(new Error("unique violation on review_threads.issue_number"));
          }
        }
        threads.set(storyId, { issueNumber, lastSyncedRevision });
        return Promise.resolve();
      },
    },

    publications: {
      createIfAbsent: (p) => {
        const existing = [...pubs.values()].find((x) => x.idempotencyKey === p.idempotencyKey);
        if (existing !== undefined) return Promise.resolve(clone(existing));
        if (isLive(p) && [...pubs.values()].some((x) => x.storyId === p.storyId && isLive(x))) {
          return Promise.reject(new Error("unique violation: publications_one_live_per_story"));
        }
        if (p.mediaId !== undefined && [...pubs.values()].some((x) => x.mediaId === p.mediaId)) {
          return Promise.reject(new Error("unique violation: publications_media_id_unique"));
        }
        const stored = withoutLease(p);
        pubs.set(p.id, stored);
        return Promise.resolve(clone(stored));
      },
      get: (id) => Promise.resolve(pubs.has(id) ? clone(pubs.get(id)) : undefined),
      claimDue: (now, leaseOwner, leaseMs) => {
        const due = [...pubs.values()]
          .filter(
            (p) =>
              (p.status === "pending" || p.status === "container_created") &&
              time(p.scheduledFor) <= now.getTime() &&
              (p.nextAttemptAt === undefined || time(p.nextAttemptAt) <= now.getTime()) &&
              leaseFree(p, now),
          )
          .sort((a, b) => time(a.scheduledFor) - time(b.scheduledFor) || a.id.localeCompare(b.id))[0];
        if (due === undefined) return Promise.resolve(undefined);
        const claimed: Publication = { ...due, leaseOwner, leaseExpiresAt: iso(new Date(now.getTime() + leaseMs)) };
        pubs.set(claimed.id, claimed);
        return Promise.resolve(clone(claimed));
      },
      claimById: (id, leaseOwner, leaseMs) => {
        const now = clock.now();
        const current = pubs.get(id);
        if (current === undefined || !leaseFree(current, now)) return Promise.resolve(undefined);
        const claimed: Publication = { ...current, leaseOwner, leaseExpiresAt: iso(new Date(now.getTime() + leaseMs)) };
        pubs.set(claimed.id, claimed);
        return Promise.resolve(clone(claimed));
      },
      save: (p, leaseOwner) => {
        const current = pubs.get(p.id);
        const now = clock.now().getTime();
        if (
          current === undefined ||
          current.leaseOwner !== leaseOwner ||
          current.leaseExpiresAt === undefined ||
          time(current.leaseExpiresAt) <= now
        ) {
          return Promise.resolve(err("lease_lost" as const));
        }
        if (p.mediaId !== undefined && [...pubs.values()].some((x) => x.id !== p.id && x.mediaId === p.mediaId)) {
          return Promise.reject(new Error("unique violation: publications_media_id_unique"));
        }
        const next: Publication = {
          ...withoutLease(p),
          id: current.id,
          storyId: current.storyId,
          draftId: current.draftId,
          idempotencyKey: current.idempotencyKey,
          leaseOwner,
          leaseExpiresAt: current.leaseExpiresAt,
        };
        pubs.set(next.id, next);
        return Promise.resolve(ok(clone(next)));
      },
      release: (id, leaseOwner) => {
        const current = pubs.get(id);
        if (current?.leaseOwner === leaseOwner) pubs.set(id, withoutLease(current));
        return Promise.resolve();
      },
      countPublishedSince: (since) =>
        Promise.resolve(
          [...pubs.values()].filter((p) => p.status === "published" && time(p.publishedAt) >= since.getTime()).length,
        ),
      lastPublishedAt: () => {
        const last = Math.max(...[...pubs.values()].map((p) => time(p.publishedAt)));
        return Promise.resolve(Number.isFinite(last) ? new Date(last) : undefined);
      },
      listByStatus: (status) =>
        Promise.resolve(
          [...pubs.values()]
            .filter((p) => p.status === status)
            .sort((a, b) => time(a.scheduledFor) - time(b.scheduledFor) || a.id.localeCompare(b.id))
            .map(clone),
        ),
      recordAttempt: (a) => {
        attempts.push(clone(a));
        return Promise.resolve();
      },
    },

    jobRuns: {
      start: (workflow) => {
        const id = uuidv7(clock.now());
        jobRuns.set(id, { workflow, status: "running", counters: {} });
        return Promise.resolve(id);
      },
      finish: (id, status, counters) => {
        const run = jobRuns.get(id);
        if (run !== undefined) jobRuns.set(id, { ...run, status, counters: { ...counters } });
        return Promise.resolve();
      },
      recordError: (e) => {
        errors.push({ jobRunId: e.jobRunId, stage: e.stage, message: e.message });
        return Promise.resolve();
      },
    },

    tokens: {
      getInstagram: () => Promise.resolve(token === undefined ? undefined : clone(token)),
      saveInstagram: (credentials) => {
        token = clone(credentials);
        return Promise.resolve();
      },
    },
  };
};
