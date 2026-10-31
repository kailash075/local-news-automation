import { z } from "zod";
import type {
  Clock,
  DecisionStore,
  DraftStore,
  EvidenceStore,
  InstagramCredentials,
  JobRunStore,
  PublicationStore,
  ReviewThreadStore,
  SettingsStore,
  NewSourceItem,
  SourceItemStore,
  SourceStateStore,
  StoryAttachment,
  Stores,
  StoryStore,
  SwitchKey,
  TokenStore,
} from "../domain/ports.ts";
import {
  DraftIdSchema,
  DraftRevisionSchema,
  GitHubLoginSchema,
  IsoDateTimeSchema,
  PublicationIdSchema,
  PublicationStatusSchema,
  Sha256HexSchema,
  SourceItemSchema,
  StoryIdSchema,
  StorySchema,
  VerificationEvidenceSchema,
  type DecisionKind,
  type DraftRevision,
  type EditorialDecision,
  type IsoDateTime,
  type Publication,
  type Source,
  type SourceItem,
  type Story,
  type StoryId,
  type VerificationEvidence,
} from "../domain/types.ts";
import { decryptSecret, encryptSecret } from "../lib/crypto.ts";
import { uuidv7 } from "../lib/ids.ts";
import { redact } from "../lib/redact.ts";
import { err, ok, type Result } from "../lib/result.ts";
import type { BridgeClient, Row } from "./bridge.ts";
import { TABLES } from "./tables.ts";

// ---------------------------------------------------------------- cells

const ts = (value: IsoDateTime | Date): string => (value instanceof Date ? value : new Date(value)).toISOString();
const tsOrEmpty = (value: IsoDateTime | undefined): string => (value === undefined ? "" : ts(value));
const bool = (value: boolean): string => (value ? "true" : "false");
const iso = (value: string): IsoDateTime => IsoDateTimeSchema.parse(value);

const cellOf = (row: Row, column: string): string => row[column] ?? "";

/** Adds `key` only when the cell is not empty, as `exactOptionalPropertyTypes` requires. */
const opt = <K extends string, V>(key: K, value: string, map: (v: string) => V): { [P in K]?: V } =>
  (value === "" ? {} : { [key]: map(value) }) as { [P in K]?: V };

const intOf = (row: Row, column: string): number => {
  const v = cellOf(row, column);
  if (!/^-?\d+$/.test(v)) throw new Error(`${column} is not a whole number: "${v.slice(0, 40)}"`);
  return Number(v);
};

/** A decimal number such as a story's priority (topic weight decayed by age, three decimals). */
const numberOf = (row: Row, column: string): number => {
  const v = cellOf(row, column);
  if (!/^-?\d+(?:\.\d+)?$/.test(v)) throw new Error(`${column} is not a number: "${v.slice(0, 40)}"`);
  return Number(v);
};

const boolOf = (row: Row, column: string): boolean => {
  const v = cellOf(row, column);
  if (v !== "true" && v !== "false") throw new Error(`${column} must be true or false, found "${v.slice(0, 40)}"`);
  return v === "true";
};

const jsonOf = (row: Row, column: string): unknown => {
  try {
    return JSON.parse(cellOf(row, column)) as unknown;
  } catch {
    throw new Error(`${column} is not valid JSON`);
  }
};

/** Names the tab and row when a hand-edited cell no longer parses. */
const parseRow = <T>(table: string, row: Row, map: (row: Row) => T): T => {
  try {
    return map(row);
  } catch (error) {
    const what = error instanceof z.ZodError ? z.prettifyError(error) : error instanceof Error ? error.message : String(error);
    throw new Error(`Sheet tab "${table}", row ${cellOf(row, "id") || cellOf(row, "story_id") || "?"}: ${what}`, { cause: error });
  }
};

const byColumns =
  (...columns: readonly string[]) =>
  (a: Row, b: Row): number => {
    for (const c of columns) {
      const x = cellOf(a, c);
      const y = cellOf(b, c);
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  };

/**
 * Inserts rows keyed by `id`, one result per row. A row with the same id is our own earlier request whose answer was
 * lost, so it counts as inserted; any other clash on the unique key is reported.
 */
const insertRows = async (bridge: BridgeClient, table: string, rows: readonly Row[], unique: readonly string[] = ["id"]): Promise<readonly boolean[]> => {
  const results = await bridge.insert(table, rows, { unique });
  if (results.length !== rows.length) throw new Error(`bridge returned ${results.length} results for ${rows.length} rows inserted into ${table}`);
  return rows.map((row, i) => {
    const result = results[i];
    return result !== undefined && (result.inserted || cellOf(result.existing, "id") === cellOf(row, "id"));
  });
};

const insertOnce = async (bridge: BridgeClient, table: string, row: Row, unique: readonly string[] = ["id"]): Promise<boolean> =>
  (await insertRows(bridge, table, [row], unique))[0] === true;

/** Loads at most once per job and shares the request between concurrent callers. A failed load is tried again next time. */
const lazy = <T>(load: () => Promise<T>): (() => Promise<T>) => {
  let pending: Promise<T> | undefined;
  return () =>
    (pending ??= load().catch((error: unknown) => {
      pending = undefined;
      throw error;
    }));
};

/** Rows grouped by their story_id, under the ids the caller asked for, in row order. */
const groupByStory = <T>(storyIds: readonly StoryId[], rows: readonly Row[], map: (row: Row) => T): Map<StoryId, T[]> => {
  const wanted = new Map<string, StoryId>(storyIds.map((id) => [id, id]));
  const groups = new Map<StoryId, T[]>();
  for (const row of rows) {
    const id = wanted.get(cellOf(row, "story_id"));
    if (id === undefined) continue;
    const group = groups.get(id) ?? [];
    group.push(map(row));
    groups.set(id, group);
  }
  return groups;
};

// ---------------------------------------------------------------- mapping

const storyRow = (s: Story): Row => ({
  id: s.id,
  status: s.status,
  version: String(s.version),
  topic: s.topic,
  place_tags: JSON.stringify(s.placeTags),
  risk_tier: s.riskTier,
  risk_flags: JSON.stringify(s.riskFlags),
  disputed: bool(s.disputed),
  priority: String(s.priority),
  first_seen_at: ts(s.firstSeenAt),
  updated_at: ts(s.updatedAt),
  expires_at: tsOrEmpty(s.expiresAt),
});

const storyFromRow = (row: Row): Story =>
  parseRow(TABLES.stories.name, row, (r) =>
    StorySchema.parse({
      id: cellOf(r, "id"),
      status: cellOf(r, "status"),
      version: intOf(r, "version"),
      topic: cellOf(r, "topic"),
      placeTags: jsonOf(r, "place_tags"),
      riskTier: cellOf(r, "risk_tier"),
      riskFlags: jsonOf(r, "risk_flags"),
      disputed: boolOf(r, "disputed"),
      priority: numberOf(r, "priority"),
      firstSeenAt: cellOf(r, "first_seen_at"),
      updatedAt: cellOf(r, "updated_at"),
      ...opt("expiresAt", cellOf(r, "expires_at"), iso),
    }),
  );

const sourceItemFromRow = (row: Row): SourceItem =>
  parseRow(TABLES.sourceItems.name, row, (r) =>
    SourceItemSchema.parse({
      id: cellOf(r, "id"),
      sourceId: cellOf(r, "source_id"),
      canonicalUrl: cellOf(r, "canonical_url"),
      urlHash: cellOf(r, "url_hash"),
      title: cellOf(r, "title"),
      ...opt("excerpt", cellOf(r, "excerpt"), (v) => v),
      language: cellOf(r, "language"),
      ...opt("publishedAt", cellOf(r, "published_at"), iso),
      fetchedAt: cellOf(r, "fetched_at"),
      contentHash: cellOf(r, "content_hash"),
    }),
  );

const draftRow = (d: DraftRevision): Row => ({
  id: d.id,
  story_id: d.storyId,
  revision: String(d.revision),
  revision_hash: d.revisionHash,
  headline_ta: d.headlineTa,
  caption_ta: d.captionTa,
  hashtags: JSON.stringify(d.hashtags),
  alt_text: d.altText,
  source_credit_ta: d.sourceCreditTa,
  template_version: d.templateVersion,
  render_key: d.renderKey ?? "",
  render_sha256: d.renderSha256 ?? "",
  origin: d.origin,
  created_at: ts(d.createdAt),
});

const draftFromRow = (row: Row): DraftRevision =>
  parseRow(TABLES.drafts.name, row, (r) =>
    DraftRevisionSchema.parse({
      id: cellOf(r, "id"),
      storyId: cellOf(r, "story_id"),
      revision: intOf(r, "revision"),
      revisionHash: cellOf(r, "revision_hash"),
      headlineTa: cellOf(r, "headline_ta"),
      captionTa: cellOf(r, "caption_ta"),
      hashtags: jsonOf(r, "hashtags"),
      altText: cellOf(r, "alt_text"),
      sourceCreditTa: cellOf(r, "source_credit_ta"),
      templateVersion: cellOf(r, "template_version"),
      ...opt("renderKey", cellOf(r, "render_key"), (v) => v),
      ...opt("renderSha256", cellOf(r, "render_sha256"), (v) => v),
      origin: cellOf(r, "origin"),
      createdAt: cellOf(r, "created_at"),
    }),
  );

const evidenceFromRow = (row: Row): VerificationEvidence =>
  parseRow(TABLES.evidence.name, row, (r) => {
    const kind = cellOf(r, "kind");
    switch (kind) {
      case "official_source": {
        const [first] = z.array(z.string()).parse(jsonOf(r, "source_item_ids"));
        return VerificationEvidenceSchema.parse({ kind, sourceItemId: first });
      }
      case "independent_corroboration":
        return VerificationEvidenceSchema.parse({ kind, sourceItemIds: jsonOf(r, "source_item_ids") });
      case "editor_attestation":
        return VerificationEvidenceSchema.parse({
          kind,
          editorLogin: cellOf(r, "editor_login"),
          method: cellOf(r, "method"),
          attestedAt: cellOf(r, "attested_at"),
        });
      default:
        throw new Error(`unknown evidence kind "${kind}"`);
    }
  });

export const DECISION_KINDS = [
  "caption",
  "headline",
  "approve",
  "approve_sensitive",
  "schedule",
  "attest",
  "hold",
  "unhold",
  "reject",
  "retract",
  "killswitch_on",
  "killswitch_off",
] as const satisfies readonly DecisionKind[];

const DecisionKindSchema = z.enum(DECISION_KINDS);

const decisionFromRow = (row: Row): EditorialDecision =>
  parseRow(TABLES.decisions.name, row, (r) => ({
    storyId: StoryIdSchema.parse(cellOf(r, "story_id")),
    kind: DecisionKindSchema.parse(cellOf(r, "kind")),
    editorLogin: GitHubLoginSchema.parse(cellOf(r, "editor_login")),
    githubCommentId: intOf(r, "github_comment_id"),
    ...opt("revisionHash", cellOf(r, "revision_hash"), (v) => Sha256HexSchema.parse(v)),
    ...opt("reason", cellOf(r, "reason"), (v) => v),
    ...opt("scheduledFor", cellOf(r, "scheduled_for"), iso),
    createdAt: iso(cellOf(r, "created_at")),
  }));

/** Fields a lease holder may change. Lease columns, ids and the idempotency key are never written by `save`. */
const publicationMutableRow = (p: Publication): Row => ({
  status: p.status,
  scheduled_for: ts(p.scheduledFor),
  attempts: String(p.attempts),
  container_id: p.containerId ?? "",
  container_created_at: tsOrEmpty(p.containerCreatedAt),
  publish_requested_at: tsOrEmpty(p.publishRequestedAt),
  media_id: p.mediaId ?? "",
  permalink: p.permalink ?? "",
  next_attempt_at: tsOrEmpty(p.nextAttemptAt),
  published_at: tsOrEmpty(p.publishedAt),
  last_error: p.lastError === undefined ? "" : redact(p.lastError),
});

const publicationFromRow = (row: Row): Publication =>
  parseRow(TABLES.publications.name, row, (r) => ({
    id: PublicationIdSchema.parse(cellOf(r, "id")),
    storyId: StoryIdSchema.parse(cellOf(r, "story_id")),
    draftId: DraftIdSchema.parse(cellOf(r, "draft_id")),
    idempotencyKey: Sha256HexSchema.parse(cellOf(r, "idempotency_key")),
    status: PublicationStatusSchema.parse(cellOf(r, "status")),
    scheduledFor: iso(cellOf(r, "scheduled_for")),
    attempts: intOf(r, "attempts"),
    ...opt("containerId", cellOf(r, "container_id"), (v) => v),
    ...opt("containerCreatedAt", cellOf(r, "container_created_at"), iso),
    ...opt("publishRequestedAt", cellOf(r, "publish_requested_at"), iso),
    ...opt("mediaId", cellOf(r, "media_id"), (v) => v),
    ...opt("permalink", cellOf(r, "permalink"), (v) => v),
    ...opt("nextAttemptAt", cellOf(r, "next_attempt_at"), iso),
    ...opt("leaseOwner", cellOf(r, "lease_owner"), (v) => v),
    ...opt("leaseExpiresAt", cellOf(r, "lease_expires_at"), iso),
    ...opt("publishedAt", cellOf(r, "published_at"), iso),
    ...opt("lastError", cellOf(r, "last_error"), (v) => v),
  }));

const NOT_LIVE: readonly Publication["status"][] = ["cancelled", "publish_failed"];

// ---------------------------------------------------------------- registry mirror

/**
 * Mirrors the version-controlled source registry into the `sources` tab. Registry columns are overwritten;
 * fetch state (etag, last fetch, failures) is kept. Call before collecting.
 */
export const syncSources = async (bridge: BridgeClient, registry: readonly Source[], clock: Clock): Promise<void> => {
  const now = ts(clock.now());
  const ops = registry.map((s) => ({
    op: "upsert" as const,
    table: TABLES.sources.name,
    match: ["id"],
    row: {
      id: s.id,
      name: s.name,
      kind: s.kind,
      url: s.url,
      trust_tier: s.trustTier,
      erode_specific: bool(s.erodeSpecific),
      terms_status: s.termsReview.status,
      terms_reviewed_by: s.termsReview.reviewedBy ?? "",
      terms_reviewed_at: tsOrEmpty(s.termsReview.reviewedAt),
      terms_notes: s.termsReview.notes,
      allowed_use: s.termsReview.allowedUse,
      llm_input_allowed: bool(s.termsReview.llmInputAllowed),
      link_pattern: s.linkPattern ?? "",
      fetch_interval_minutes: String(s.fetchIntervalMinutes),
      enabled: bool(s.enabled),
      updated_at: now,
    },
  }));
  for (let i = 0; i < ops.length; i += 40) await bridge.batch(ops.slice(i, i + 40));
};

// ---------------------------------------------------------------- stores

export type SheetStoreOptions = {
  clock: Clock;
  /** 32-byte AES key (TOKEN_ENCRYPTION_KEY). Without it the token store refuses to read or write. */
  tokenKey?: Uint8Array;
  tokenKeyVersion?: number;
};

/** A value typed by hand that is neither "true" nor "false" reads as the safe state: collecting paused, kill switch pulled. */
const SAFE_WHEN_INVALID: Readonly<Record<SwitchKey, boolean>> = { collecting_enabled: false, kill_switch: true };

const createSettingsStore = (bridge: BridgeClient, clock: Clock): SettingsStore => ({
  getSwitch: async (key) => {
    const [row] = await bridge.select(TABLES.settings.name, { key });
    if (row === undefined) return { enabled: false, reason: "not set", updatedBy: "system" };
    const enabled = cellOf(row, "enabled");
    const valid = enabled === "true" || enabled === "false";
    const updatedAt = IsoDateTimeSchema.safeParse(cellOf(row, "updated_at"));
    return {
      enabled: valid ? enabled === "true" : SAFE_WHEN_INVALID[key],
      reason: valid ? cellOf(row, "reason") : "invalid stored value",
      updatedBy: cellOf(row, "updated_by"),
      ...(updatedAt.success ? { updatedAt: updatedAt.data } : {}),
    };
  },
  setSwitch: async (key, enabled, updatedBy, reason) => {
    await bridge.upsert(TABLES.settings.name, ["key"], { key, enabled: bool(enabled), reason, updated_by: updatedBy, updated_at: ts(clock.now()) });
  },
});

/**
 * Reads every source's fetch state in one request, the first time a job asks, and keeps it up to date with the job's own
 * saves. Only the collect workflow writes fetch state, and it never runs twice at once.
 */
const createSourceStateStore = (bridge: BridgeClient): SourceStateStore => {
  const rowsById = lazy(async () => {
    const rows = await bridge.select(TABLES.sources.name, undefined, ["id", "etag", "last_modified", "last_fetched_at", "consecutive_failures"]);
    return new Map(rows.map((row) => [cellOf(row, "id"), row]));
  });
  return {
    getFetchState: async (sourceId) => {
      const row = (await rowsById()).get(sourceId);
      if (row === undefined) return { sourceId, consecutiveFailures: 0 };
      return {
        sourceId,
        ...opt("etag", cellOf(row, "etag"), (v) => v),
        ...opt("lastModified", cellOf(row, "last_modified"), (v) => v),
        ...opt("lastFetchedAt", cellOf(row, "last_fetched_at"), iso),
        consecutiveFailures: cellOf(row, "consecutive_failures") === "" ? 0 : intOf(row, "consecutive_failures"),
      };
    },
    saveFetchState: async (state) => {
      const [updated] = await bridge.update(
        TABLES.sources.name,
        { id: state.sourceId },
        {
          etag: state.etag ?? "",
          last_modified: state.lastModified ?? "",
          last_fetched_at: tsOrEmpty(state.lastFetchedAt),
          consecutive_failures: String(state.consecutiveFailures),
        },
      );
      if (updated === undefined) throw new Error(`source ${state.sourceId} is not in the sources tab; run syncSources with the registry first`);
      (await rowsById()).set(state.sourceId, updated);
    },
  };
};

/** Links per bridge batch: one insert plus two updates per link stay under the bridge's 50 operations. */
const ATTACHMENTS_PER_BATCH = 24;

const createSourceItemStore = (bridge: BridgeClient, clock: Clock): SourceItemStore => {
  const table = TABLES.sourceItems.name;
  const keyOf = (sourceId: string, urlHash: string): string => `${sourceId} ${urlHash}`;
  /** (source, url hash) pairs already in the Sheet. Rows are never deleted, so a known pair stays known. */
  const knownKeys = lazy(async () =>
    new Set((await bridge.select(table, undefined, ["source_id", "url_hash"])).map((r) => keyOf(cellOf(r, "source_id"), cellOf(r, "url_hash")))),
  );

  const insertManyIfNew = async (items: readonly NewSourceItem[]): Promise<readonly SourceItem[]> => {
    const keys = await knownKeys();
    const fresh = new Set<string>();
    const rows: Row[] = [];
    const start = clock.now().getTime();
    for (const item of items) {
      const key = keyOf(item.sourceId, item.urlHash);
      if (keys.has(key) || fresh.has(key)) continue;
      fresh.add(key);
      rows.push({
        // One millisecond apart, so the ids keep the order given (the page's order), as one-by-one inserts did.
        id: uuidv7(new Date(start + rows.length)),
        source_id: item.sourceId,
        canonical_url: item.canonicalUrl,
        url_hash: item.urlHash,
        title: item.title,
        excerpt: item.excerpt ?? "",
        language: item.language,
        published_at: tsOrEmpty(item.publishedAt),
        fetched_at: ts(item.fetchedAt),
        content_hash: item.contentHash,
        story_id: "",
      });
    }
    if (rows.length === 0) return [];
    const inserted = await insertRows(bridge, table, rows, ["source_id", "url_hash"]);
    for (const key of fresh) keys.add(key);
    return rows.filter((_, i) => inserted[i] === true).map(sourceItemFromRow);
  };

  const attachToStories = async (attachments: readonly StoryAttachment[]): Promise<void> => {
    const createdAt = ts(clock.now());
    const link = (a: StoryAttachment) => ({ story_id: a.storyId, source_item_id: a.itemId });
    for (let i = 0; i < attachments.length; i += ATTACHMENTS_PER_BATCH) {
      const chunk = attachments.slice(i, i + ATTACHMENTS_PER_BATCH);
      await bridge.batch([
        {
          op: "insert",
          table: TABLES.storySources.name,
          rows: chunk.map((a) => ({ ...link(a), relation: a.relation, created_at: createdAt })),
          unique: ["story_id", "source_item_id"],
        },
        ...chunk.flatMap((a) => [
          { op: "update", table: TABLES.storySources.name, where: link(a), set: { relation: a.relation } } as const,
          { op: "update", table, where: { id: a.itemId, story_id: null }, set: { story_id: a.storyId } } as const,
        ]),
      ]);
    }
  };

  const listForStories = async (storyIds: readonly StoryId[]): Promise<ReadonlyMap<StoryId, readonly SourceItem[]>> => {
    if (storyIds.length === 0) return new Map();
    const links = await bridge.select(TABLES.storySources.name, { story_id: storyIds }, ["story_id", "source_item_id"]);
    if (links.length === 0) return new Map();
    const rows = await bridge.select(table, { id: [...new Set(links.map((l) => cellOf(l, "source_item_id")))] });
    const items = [...rows].sort(byColumns("fetched_at", "id")).map(sourceItemFromRow);
    const byStory = new Map<StoryId, readonly SourceItem[]>();
    for (const [storyId, itemIds] of groupByStory(storyIds, links, (l) => cellOf(l, "source_item_id"))) {
      const mine = new Set(itemIds);
      byStory.set(storyId, items.filter((item) => mine.has(item.id)));
    }
    return byStory;
  };

  return {
    isKnown: async (sourceId, urlHash) => (await knownKeys()).has(keyOf(sourceId, urlHash)),
    insertIfNew: async (item) => {
      const [stored] = await insertManyIfNew([item]);
      return stored === undefined ? { inserted: false } : { inserted: true, item: stored };
    },
    insertManyIfNew,
    listUnassigned: async (limit) =>
      [...(await bridge.select(table, { story_id: null }))].sort(byColumns("fetched_at", "id")).slice(0, limit).map(sourceItemFromRow),
    attachToStory: (itemId, storyId, relation) => attachToStories([{ itemId, storyId, relation }]),
    attachToStories,
    listForStory: async (storyId) => (await listForStories([storyId])).get(storyId) ?? [],
    listForStories,
  };
};

const createStoryStore = (bridge: BridgeClient): StoryStore => {
  const table = TABLES.stories.name;
  const insertMany = async (stories: readonly Story[]): Promise<void> => {
    if (stories.length === 0) return;
    const inserted = await insertRows(bridge, table, stories.map(storyRow));
    const clash = stories.find((_, i) => inserted[i] !== true);
    if (clash !== undefined) throw new Error(`story ${clash.id} already exists`);
  };
  return {
    insert: (story) => insertMany([story]),
    insertMany,
    get: async (id) => {
      const [row] = await bridge.select(table, { id });
      return row === undefined ? undefined : storyFromRow(row);
    },
    update: async (story, expectedVersion): Promise<Result<Story, "version_conflict" | "not_found">> => {
      const next: Row = { ...storyRow(story), version: String(expectedVersion + 1) };
      const set = Object.fromEntries(Object.entries(next).filter(([c]) => c !== "id" && c !== "first_seen_at"));
      const [row] = await bridge.update(table, { id: story.id, version: String(expectedVersion) }, set);
      if (row !== undefined) return ok(storyFromRow(row));
      const [current] = await bridge.select(table, { id: story.id });
      if (current === undefined) return err("not_found");
      // Our own earlier request, whose answer was lost, already wrote exactly this.
      if (Object.entries(set).every(([c, v]) => cellOf(current, c) === v)) return ok(storyFromRow(current));
      return err("version_conflict");
    },
    listByStatus: async (statuses, limit) => {
      if (statuses.length === 0) return [];
      const rows = await bridge.select(table, { status: statuses });
      return rows
        .map(storyFromRow)
        .sort((a, b) => b.priority - a.priority || a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id))
        .slice(0, limit);
    },
    listRecentWithItems: async (since) => {
      const [storyRows, links] = await bridge.batch([
        { op: "select", table, where: { first_seen_at: { gte: ts(since) } } },
        { op: "select", table: TABLES.storySources.name, columns: ["story_id", "source_item_id"] },
      ]);
      if (storyRows.length === 0) return [];
      const ids = new Set(storyRows.map((r) => cellOf(r, "id")));
      const wanted = links.filter((l) => ids.has(cellOf(l, "story_id")));
      const itemRows = wanted.length === 0 ? [] : await bridge.select(TABLES.sourceItems.name, { id: [...new Set(wanted.map((l) => cellOf(l, "source_item_id")))] });
      const itemById = new Map([...itemRows].sort(byColumns("fetched_at", "id")).map((r) => [cellOf(r, "id"), sourceItemFromRow(r)] as const));
      const order = [...itemById.keys()];
      return [...storyRows].sort(byColumns("first_seen_at", "id")).map((row) => {
        const story = storyFromRow(row);
        const mine = new Set(wanted.filter((l) => cellOf(l, "story_id") === story.id).map((l) => cellOf(l, "source_item_id")));
        const items = order.filter((id) => mine.has(id)).flatMap((id) => {
          const item = itemById.get(id);
          return item === undefined ? [] : [item];
        });
        return { story, items };
      });
    },
  };
};

const createDraftStore = (bridge: BridgeClient): DraftStore => {
  const table = TABLES.drafts.name;
  const latestForStories = async (storyIds: readonly StoryId[]): Promise<ReadonlyMap<StoryId, DraftRevision>> => {
    const latest = new Map<StoryId, DraftRevision>();
    if (storyIds.length === 0) return latest;
    for (const [storyId, drafts] of groupByStory(storyIds, await bridge.select(table, { story_id: storyIds }), draftFromRow)) {
      latest.set(storyId, drafts.reduce((best, d) => (d.revision > best.revision ? d : best)));
    }
    return latest;
  };
  return {
    insert: async (d) => {
      const [result] = await bridge.insert(table, [draftRow(d)], {
        unique: ["id"],
        refuseIf: { name: "drafts_story_revision_unique", where: { story_id: d.storyId, revision: String(d.revision) } },
      });
      if (result === undefined) throw new Error("bridge returned no result for the draft insert");
    },
    get: async (id) => {
      const [row] = await bridge.select(table, { id });
      return row === undefined ? undefined : draftFromRow(row);
    },
    latestFor: async (storyId) => (await latestForStories([storyId])).get(storyId),
    latestForStories,
  };
};

const createEvidenceStore = (bridge: BridgeClient, clock: Clock): EvidenceStore => {
  const listForStories = async (storyIds: readonly StoryId[]): Promise<ReadonlyMap<StoryId, readonly VerificationEvidence[]>> => {
    if (storyIds.length === 0) return new Map();
    const rows = [...(await bridge.select(TABLES.evidence.name, { story_id: storyIds }))].sort(byColumns("created_at", "id"));
    return groupByStory(storyIds, rows, evidenceFromRow);
  };
  return {
    add: async (storyId, evidence) => {
      const now = clock.now();
      const base = { id: uuidv7(now), story_id: storyId, kind: evidence.kind, created_at: ts(now) };
      switch (evidence.kind) {
        case "official_source":
          await insertOnce(bridge, TABLES.evidence.name, { ...base, source_item_ids: JSON.stringify([evidence.sourceItemId]) });
          return;
        case "independent_corroboration":
          await insertOnce(bridge, TABLES.evidence.name, { ...base, source_item_ids: JSON.stringify(evidence.sourceItemIds) });
          return;
        case "editor_attestation":
          await insertOnce(bridge, TABLES.evidence.name, {
            ...base,
            editor_login: evidence.editorLogin,
            method: evidence.method,
            attested_at: ts(evidence.attestedAt),
          });
          return;
      }
    },
    listFor: async (storyId) => (await listForStories([storyId])).get(storyId) ?? [],
    listForStories,
  };
};

const createDecisionStore = (bridge: BridgeClient, clock: Clock): DecisionStore => {
  const listForStories = async (storyIds: readonly StoryId[]): Promise<ReadonlyMap<StoryId, readonly EditorialDecision[]>> => {
    if (storyIds.length === 0) return new Map();
    const rows = [...(await bridge.select(TABLES.decisions.name, { story_id: storyIds }))].sort(byColumns("created_at", "id"));
    return groupByStory(storyIds, rows, decisionFromRow);
  };
  return {
    record: async (d) => {
      const recorded = await insertOnce(
        bridge,
        TABLES.decisions.name,
        {
          id: uuidv7(clock.now()),
          story_id: d.storyId,
          kind: d.kind,
          editor_login: d.editorLogin,
          github_comment_id: String(d.githubCommentId),
          revision_hash: d.revisionHash ?? "",
          reason: d.reason ?? "",
          scheduled_for: tsOrEmpty(d.scheduledFor),
          created_at: ts(d.createdAt),
        },
        ["github_comment_id"],
      );
      return { recorded };
    },
    listFor: async (storyId) => (await listForStories([storyId])).get(storyId) ?? [],
    listForStories,
  };
};

const createReviewThreadStore = (bridge: BridgeClient, clock: Clock): ReviewThreadStore => {
  const table = TABLES.reviewThreads.name;
  const issueNumbersFor = async (storyIds: readonly StoryId[]): Promise<ReadonlyMap<StoryId, number>> => {
    const numbers = new Map<StoryId, number>();
    if (storyIds.length === 0) return numbers;
    const rows = await bridge.select(table, { story_id: storyIds }, ["story_id", "issue_number"]);
    for (const [storyId, [issueNumber]] of groupByStory(storyIds, rows, (r) => intOf(r, "issue_number"))) {
      if (issueNumber !== undefined) numbers.set(storyId, issueNumber);
    }
    return numbers;
  };
  return {
    getIssueNumber: async (storyId) => (await issueNumbersFor([storyId])).get(storyId),
    issueNumbersFor,
    getStoryId: async (issueNumber) => {
      const [row] = await bridge.select(table, { issue_number: String(issueNumber) }, ["story_id"]);
      return row === undefined ? undefined : StoryIdSchema.parse(cellOf(row, "story_id"));
    },
    save: async (storyId, issueNumber, lastSyncedRevision) => {
      await bridge.upsert(table, ["story_id"], {
        story_id: storyId,
        issue_number: String(issueNumber),
        last_synced_revision: String(lastSyncedRevision),
        updated_at: ts(clock.now()),
      });
    },
  };
};

const createPublicationStore = (bridge: BridgeClient, clock: Clock): PublicationStore => {
  const table = TABLES.publications.name;
  const leaseFree = (now: Date) => ({ lte: ts(now), orEmpty: true });
  const claimed = (rows: readonly Row[]): Publication | undefined => (rows[0] === undefined ? undefined : publicationFromRow(rows[0]));
  return {
    createIfAbsent: async (p) => {
      const now = ts(clock.now());
      const row: Row = {
        id: p.id,
        story_id: p.storyId,
        draft_id: p.draftId,
        idempotency_key: p.idempotencyKey,
        ...publicationMutableRow(p),
        lease_owner: "",
        lease_expires_at: "",
        created_at: now,
        updated_at: now,
      };
      const live = !NOT_LIVE.includes(p.status);
      const [result] = await bridge.insert(table, [row], {
        unique: ["idempotency_key"],
        ...(live ? { refuseIf: { name: "publications_one_live_per_story", where: { story_id: p.storyId, status: { notIn: NOT_LIVE } } } } : {}),
      });
      if (result === undefined) throw new Error("bridge returned no result for the publication insert");
      return publicationFromRow(result.inserted ? row : result.existing);
    },
    get: async (id) => claimed(await bridge.select(table, { id })),
    claimDue: async (now, leaseOwner, leaseMs) =>
      claimed(
        await bridge.update(
          table,
          {
            status: ["pending", "container_created"],
            scheduled_for: { lte: ts(now) },
            next_attempt_at: { lte: ts(now), orEmpty: true },
            lease_expires_at: leaseFree(now),
          },
          { lease_owner: leaseOwner, lease_expires_at: ts(new Date(now.getTime() + leaseMs)), updated_at: ts(now) },
          { orderBy: ["scheduled_for", "id"], limit: 1 },
        ),
      ),
    claimById: async (id, leaseOwner, leaseMs) => {
      const now = clock.now();
      return claimed(
        await bridge.update(
          table,
          { id, lease_expires_at: leaseFree(now) },
          { lease_owner: leaseOwner, lease_expires_at: ts(new Date(now.getTime() + leaseMs)), updated_at: ts(now) },
          { limit: 1 },
        ),
      );
    },
    save: async (p, leaseOwner) => {
      const now = clock.now();
      const rows = await bridge.update(
        table,
        { id: p.id, lease_owner: leaseOwner, lease_expires_at: { gt: ts(now) } },
        { ...publicationMutableRow(p), updated_at: ts(now) },
      );
      const saved = claimed(rows);
      return saved === undefined ? err("lease_lost") : ok(saved);
    },
    release: async (id, leaseOwner) => {
      await bridge.update(table, { id, lease_owner: leaseOwner }, { lease_owner: "", lease_expires_at: "", updated_at: ts(clock.now()) });
    },
    countPublishedSince: async (since) => (await bridge.select(table, { status: "published", published_at: { gte: ts(since) } }, ["id"])).length,
    lastPublishedAt: async () => {
      const latest = (await bridge.select(table, { published_at: {} }, ["published_at"]))
        .map((r) => cellOf(r, "published_at"))
        .reduce<string | undefined>((best, v) => (best === undefined || v > best ? v : best), undefined);
      return latest === undefined ? undefined : new Date(latest);
    },
    listByStatus: async (status) => [...(await bridge.select(table, { status }))].sort(byColumns("scheduled_for", "id")).map(publicationFromRow),
    recordAttempt: async (a) => {
      await insertOnce(bridge, TABLES.publishAttempts.name, {
        id: uuidv7(new Date(a.at)),
        publication_id: a.publicationId,
        step: a.step,
        outcome: a.outcome,
        http_status: a.httpStatus === undefined ? "" : String(a.httpStatus),
        error_code: a.errorCode === undefined ? "" : String(a.errorCode),
        error_subcode: a.errorSubcode === undefined ? "" : String(a.errorSubcode),
        is_transient: a.isTransient === undefined ? "" : bool(a.isTransient),
        detail: a.detail === undefined ? "" : redact(a.detail),
        created_at: ts(a.at),
      });
    },
  };
};

const createJobRunStore = (bridge: BridgeClient, clock: Clock): JobRunStore => ({
  start: async (workflow, runId, gitSha) => {
    const now = clock.now();
    const id = uuidv7(now);
    await insertOnce(bridge, TABLES.jobRuns.name, { id, workflow, run_id: runId, git_sha: gitSha, started_at: ts(now), status: "running", counters: "{}" });
    return id;
  },
  finish: async (id, status, counters) => {
    await bridge.update(TABLES.jobRuns.name, { id }, { status, counters: JSON.stringify(counters), finished_at: ts(clock.now()) });
  },
  recordError: async (e) => {
    const now = clock.now();
    await insertOnce(bridge, TABLES.errors.name, {
      id: uuidv7(now),
      job_run_id: e.jobRunId,
      stage: e.stage,
      entity_type: e.entityType ?? "",
      entity_id: e.entityId ?? "",
      error_class: e.errorClass,
      code: e.code ?? "",
      message: redact(e.message),
      retryable: bool(e.retryable),
      created_at: ts(now),
    });
  },
});

/** Kept in the bridge's Script properties, never in a Sheet tab; and encrypted, so the Google account alone cannot read it. */
export const INSTAGRAM_TOKEN_SECRET = "instagram_token";
const tokenAad = (name: string): string => `erodeglitz.secrets:${name}`;

const StoredCredentialsSchema = z.strictObject({
  igUserId: z.string().regex(/^\d+$/),
  accessToken: z.string().min(1),
  obtainedAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
}) satisfies z.ZodType<InstagramCredentials>;

const EnvelopeSchema = z.strictObject({
  keyVersion: z.number().int().min(1),
  iv: z.base64(),
  authTag: z.base64(),
  ciphertext: z.base64(),
  /** Readable without the key, for expiry alerts. */
  expiresAt: IsoDateTimeSchema,
});

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const unb64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "base64"));

const createTokenStore = (bridge: BridgeClient, key: Uint8Array | undefined, keyVersion: number): TokenStore => {
  const requireKey = (): Uint8Array => {
    if (key === undefined) throw new Error("TOKEN_ENCRYPTION_KEY is not configured; the Instagram token cannot be read or stored");
    return key;
  };
  return {
    getInstagram: async () => {
      const k = requireKey();
      const stored = await bridge.secretGet(INSTAGRAM_TOKEN_SECRET);
      if (stored === undefined) return undefined;
      const envelope = EnvelopeSchema.parse(JSON.parse(stored));
      const plaintext = decryptSecret(
        k,
        { ciphertext: unb64(envelope.ciphertext), iv: unb64(envelope.iv), authTag: unb64(envelope.authTag), keyVersion: envelope.keyVersion },
        tokenAad(INSTAGRAM_TOKEN_SECRET),
      );
      const parsed = StoredCredentialsSchema.safeParse(JSON.parse(plaintext));
      if (!parsed.success) throw new Error("stored Instagram credentials have an unexpected shape");
      return parsed.data;
    },
    saveInstagram: async (credentials) => {
      const k = requireKey();
      const valid = StoredCredentialsSchema.parse(credentials);
      const enc = encryptSecret(k, JSON.stringify(valid), tokenAad(INSTAGRAM_TOKEN_SECRET), keyVersion);
      const envelope: z.infer<typeof EnvelopeSchema> = {
        keyVersion: enc.keyVersion,
        iv: b64(enc.iv),
        authTag: b64(enc.authTag),
        ciphertext: b64(enc.ciphertext),
        expiresAt: valid.expiresAt,
      };
      await bridge.secretPut(INSTAGRAM_TOKEN_SECRET, JSON.stringify(envelope));
    },
  };
};

export const createSheetStores = (bridge: BridgeClient, options: SheetStoreOptions): Stores => {
  const { clock } = options;
  return {
    settings: createSettingsStore(bridge, clock),
    sourceState: createSourceStateStore(bridge),
    sourceItems: createSourceItemStore(bridge, clock),
    stories: createStoryStore(bridge),
    drafts: createDraftStore(bridge),
    evidence: createEvidenceStore(bridge, clock),
    decisions: createDecisionStore(bridge, clock),
    reviewThreads: createReviewThreadStore(bridge, clock),
    publications: createPublicationStore(bridge, clock),
    jobRuns: createJobRunStore(bridge, clock),
    tokens: createTokenStore(bridge, options.tokenKey, options.tokenKeyVersion ?? 1),
  };
};
