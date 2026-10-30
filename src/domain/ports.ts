import type { Result } from "../lib/result.ts";
import type {
  DraftId,
  DraftRevision,
  EditorialDecision,
  IsoDateTime,
  Publication,
  PublicationId,
  SourceId,
  SourceItem,
  SourceItemId,
  Story,
  StoryId,
  StoryStatus,
  VerificationEvidence,
} from "./types.ts";

/**
 * Persistence and I/O boundaries. Domain and job code depend on these types only.
 * `src/sheet` implements the stores on the Google Sheet (through the Apps Script bridge); `src/storage` holds the images.
 */

export type Clock = { now: () => Date };

// ---------------------------------------------------------------- switches

/** A missing row means "off": every switch fails closed. */
export type SwitchKey = "publishing_enabled" | "collecting_enabled";

export type SwitchState = {
  enabled: boolean;
  reason: string;
  updatedBy: string;
  updatedAt?: IsoDateTime;
};

export type SettingsStore = {
  getSwitch: (key: SwitchKey) => Promise<SwitchState>;
  setSwitch: (key: SwitchKey, enabled: boolean, updatedBy: string, reason: string) => Promise<void>;
};

// ---------------------------------------------------------------- sources

export type SourceFetchState = {
  sourceId: SourceId;
  etag?: string;
  lastModified?: string;
  lastFetchedAt?: IsoDateTime;
  consecutiveFailures: number;
};

export type SourceStateStore = {
  getFetchState: (sourceId: SourceId) => Promise<SourceFetchState>;
  saveFetchState: (state: SourceFetchState) => Promise<void>;
};

export type NewSourceItem = Omit<SourceItem, "id">;

export type StoryRelation = "primary" | "corroborating" | "contradicting";

export type SourceItemStore = {
  /** Unique on (sourceId, urlHash). Returns the stored item only when it was new. */
  insertIfNew: (item: NewSourceItem) => Promise<{ inserted: true; item: SourceItem } | { inserted: false }>;
  /** Whether (sourceId, urlHash) is already stored, so a collector can skip extra work for known links. */
  isKnown: (sourceId: NewSourceItem["sourceId"], urlHash: NewSourceItem["urlHash"]) => Promise<boolean>;
  listUnassigned: (limit: number) => Promise<readonly SourceItem[]>;
  attachToStory: (itemId: SourceItemId, storyId: StoryId, relation: StoryRelation) => Promise<void>;
  listForStory: (storyId: StoryId) => Promise<readonly SourceItem[]>;
};

// ---------------------------------------------------------------- stories

export type StoryStore = {
  insert: (story: Story) => Promise<void>;
  get: (id: StoryId) => Promise<Story | undefined>;
  /** Writes only when the stored version equals `expectedVersion`; the stored version becomes `expectedVersion + 1`. */
  update: (story: Story, expectedVersion: number) => Promise<Result<Story, "version_conflict" | "not_found">>;
  listByStatus: (statuses: readonly StoryStatus[], limit: number) => Promise<readonly Story[]>;
  /** Stories first seen at or after `since`, with their source items, for near-duplicate clustering. */
  listRecentWithItems: (since: IsoDateTime) => Promise<readonly { story: Story; items: readonly SourceItem[] }[]>;
};

export type DraftStore = {
  insert: (draft: DraftRevision) => Promise<void>;
  get: (id: DraftId) => Promise<DraftRevision | undefined>;
  latestFor: (storyId: StoryId) => Promise<DraftRevision | undefined>;
};

export type EvidenceStore = {
  add: (storyId: StoryId, evidence: VerificationEvidence) => Promise<void>;
  listFor: (storyId: StoryId) => Promise<readonly VerificationEvidence[]>;
};

export type DecisionStore = {
  /** Unique on githubCommentId: a redelivered comment is not recorded twice. */
  record: (decision: EditorialDecision) => Promise<{ recorded: boolean }>;
  listFor: (storyId: StoryId) => Promise<readonly EditorialDecision[]>;
};

export type ReviewThreadStore = {
  getIssueNumber: (storyId: StoryId) => Promise<number | undefined>;
  getStoryId: (issueNumber: number) => Promise<StoryId | undefined>;
  save: (storyId: StoryId, issueNumber: number, lastSyncedRevision: number) => Promise<void>;
};

// ---------------------------------------------------------------- publishing

export type PublishStep = "gates" | "create_container" | "container_status" | "media_publish" | "fetch_permalink" | "reconcile";

export type PublishAttempt = {
  publicationId: PublicationId;
  step: PublishStep;
  outcome: "ok" | "error" | "skipped";
  httpStatus?: number;
  errorCode?: number;
  errorSubcode?: number;
  isTransient?: boolean;
  /** Redacted. Never contains a token. */
  detail?: string;
  at: IsoDateTime;
};

export type PublicationStore = {
  /** Unique on idempotencyKey: returns the existing row when there is one. */
  createIfAbsent: (publication: Publication) => Promise<Publication>;
  get: (id: PublicationId) => Promise<Publication | undefined>;
  /**
   * Atomically claims one publication that is due (`scheduledFor <= now`, `nextAttemptAt` empty or past,
   * status `pending` or `container_created`) and whose lease is free or expired.
   */
  claimDue: (now: Date, leaseOwner: string, leaseMs: number) => Promise<Publication | undefined>;
  /** Claims one specific publication (any status) whose lease is free or expired. Used by reconciliation. */
  claimById: (id: PublicationId, leaseOwner: string, leaseMs: number) => Promise<Publication | undefined>;
  /** Saves the row only while `leaseOwner` still holds the lease. */
  save: (publication: Publication, leaseOwner: string) => Promise<Result<Publication, "lease_lost">>;
  release: (id: PublicationId, leaseOwner: string) => Promise<void>;
  countPublishedSince: (since: Date) => Promise<number>;
  lastPublishedAt: () => Promise<Date | undefined>;
  listByStatus: (status: Publication["status"]) => Promise<readonly Publication[]>;
  recordAttempt: (attempt: PublishAttempt) => Promise<void>;
};

// ---------------------------------------------------------------- operations

export type JobRunId = string;

export type JobRunStore = {
  start: (workflow: string, runId: string, gitSha: string) => Promise<JobRunId>;
  finish: (id: JobRunId, status: "succeeded" | "failed" | "skipped", counters: Readonly<Record<string, number>>) => Promise<void>;
  recordError: (error: {
    jobRunId: JobRunId;
    stage: string;
    errorClass: string;
    message: string;
    retryable: boolean;
    entityType?: string;
    entityId?: string;
    code?: string;
  }) => Promise<void>;
};

export type InstagramCredentials = {
  igUserId: string;
  accessToken: string;
  obtainedAt: IsoDateTime;
  expiresAt: IsoDateTime;
};

/** Implementations encrypt the token at rest (AES-256-GCM, key outside the database). */
export type TokenStore = {
  getInstagram: () => Promise<InstagramCredentials | undefined>;
  saveInstagram: (credentials: InstagramCredentials) => Promise<void>;
};

/**
 * Rendered cards (Cloudinary). Instagram fetches the image from `publicUrl`; the URL is public but holds the image's
 * SHA-256, so it cannot be guessed, and it only appears in the private review issue and in the publish request.
 */
export type ObjectStore = {
  put: (key: string, bytes: Uint8Array, contentType: string) => Promise<void>;
  get: (key: string) => Promise<Uint8Array | undefined>;
  exists: (key: string) => Promise<boolean>;
  publicUrl: (key: string) => Promise<string>;
};

export type Stores = {
  settings: SettingsStore;
  sourceState: SourceStateStore;
  sourceItems: SourceItemStore;
  stories: StoryStore;
  drafts: DraftStore;
  evidence: EvidenceStore;
  decisions: DecisionStore;
  reviewThreads: ReviewThreadStore;
  publications: PublicationStore;
  jobRuns: JobRunStore;
  tokens: TokenStore;
};
