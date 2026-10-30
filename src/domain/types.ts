import { z } from "zod";

// ---------------------------------------------------------------- identifiers

export const StoryIdSchema = z.uuid().brand<"StoryId">();
export type StoryId = z.infer<typeof StoryIdSchema>;

export const SourceItemIdSchema = z.uuid().brand<"SourceItemId">();
export type SourceItemId = z.infer<typeof SourceItemIdSchema>;

export const DraftIdSchema = z.uuid().brand<"DraftId">();
export type DraftId = z.infer<typeof DraftIdSchema>;

export const PublicationIdSchema = z.uuid().brand<"PublicationId">();
export type PublicationId = z.infer<typeof PublicationIdSchema>;

/** Source ids are readable slugs from the registry, for example `dinamalar-erode`. */
export const SourceIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(64)
  .brand<"SourceId">();
export type SourceId = z.infer<typeof SourceIdSchema>;

export const GitHubLoginSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/)
  .brand<"GitHubLogin">();
export type GitHubLogin = z.infer<typeof GitHubLoginSchema>;

export const IsoDateTimeSchema = z.iso.datetime({ offset: true }).brand<"IsoDateTime">();
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/).brand<"Sha256Hex">();
export type Sha256Hex = z.infer<typeof Sha256HexSchema>;

// ---------------------------------------------------------------- sources

export type SourceKind = "rss" | "atom" | "sitemap" | "listing_page" | "editor_tip";
export const SourceKindSchema = z.enum(["rss", "atom", "sitemap", "listing_page", "editor_tip"]) satisfies z.ZodType<SourceKind>;

export type TrustTier = "T1_official" | "T2_established_publisher" | "T3_other";
export const TrustTierSchema = z.enum(["T1_official", "T2_established_publisher", "T3_other"]) satisfies z.ZodType<TrustTier>;

export type TermsStatus = "pending" | "approved" | "rejected";
export const TermsStatusSchema = z.enum(["pending", "approved", "rejected"]) satisfies z.ZodType<TermsStatus>;

/** Image reuse is never allowed by default, so it is not a value here. */
export type AllowedUse = "discovery_only" | "facts_with_attribution";
export const AllowedUseSchema = z.enum(["discovery_only", "facts_with_attribution"]) satisfies z.ZodType<AllowedUse>;

export type TermsReview = {
  status: TermsStatus;
  reviewedBy?: GitHubLogin;
  reviewedAt?: IsoDateTime;
  notes: string;
  allowedUse: AllowedUse;
  /** Text from this source may be sent to an AI model. Default false. */
  llmInputAllowed: boolean;
};

export const TermsReviewSchema = z.strictObject({
  status: TermsStatusSchema,
  reviewedBy: GitHubLoginSchema.exactOptional(),
  reviewedAt: IsoDateTimeSchema.exactOptional(),
  notes: z.string(),
  allowedUse: AllowedUseSchema,
  llmInputAllowed: z.boolean(),
}) satisfies z.ZodType<TermsReview>;

export type Source = {
  id: SourceId;
  name: string;
  kind: SourceKind;
  url: string;
  trustTier: TrustTier;
  /** Every item from this source is about Erode, so the gazetteer check is relaxed to "no other district named". */
  erodeSpecific: boolean;
  termsReview: TermsReview;
  /** Regular expression with one capture group for article links. Only for `listing_page`. */
  linkPattern?: string;
  fetchIntervalMinutes: number;
  enabled: boolean;
};

export const SourceSchema = z.strictObject({
  id: SourceIdSchema,
  name: z.string().min(1).max(120),
  kind: SourceKindSchema,
  url: z.url({ protocol: /^https$/ }),
  trustTier: TrustTierSchema,
  erodeSpecific: z.boolean(),
  termsReview: TermsReviewSchema,
  linkPattern: z.string().min(1).exactOptional(),
  fetchIntervalMinutes: z.int().min(30).max(24 * 60),
  enabled: z.boolean(),
}) satisfies z.ZodType<Source>;

export type Language = "ta" | "en" | "other";
export const LanguageSchema = z.enum(["ta", "en", "other"]) satisfies z.ZodType<Language>;

/** Only metadata and a short excerpt are kept. Full articles are never stored. */
export const MAX_EXCERPT_CHARS = 500;

export type SourceItem = {
  id: SourceItemId;
  sourceId: SourceId;
  canonicalUrl: string;
  urlHash: Sha256Hex;
  title: string;
  excerpt?: string;
  language: Language;
  publishedAt?: IsoDateTime;
  fetchedAt: IsoDateTime;
  contentHash: Sha256Hex;
};

export const SourceItemSchema = z.strictObject({
  id: SourceItemIdSchema,
  sourceId: SourceIdSchema,
  canonicalUrl: z.url(),
  urlHash: Sha256HexSchema,
  title: z.string().min(1).max(500),
  excerpt: z.string().max(MAX_EXCERPT_CHARS).exactOptional(),
  language: LanguageSchema,
  publishedAt: IsoDateTimeSchema.exactOptional(),
  fetchedAt: IsoDateTimeSchema,
  contentHash: Sha256HexSchema,
}) satisfies z.ZodType<SourceItem>;

// ---------------------------------------------------------------- topics and risk

/** Topic drives queue priority (the Coimbatore 360 lesson: power cuts first). Risk is separate. */
export type Topic =
  | "power_cut"
  | "water_supply"
  | "weather"
  | "traffic"
  | "jobs"
  | "education"
  | "health"
  | "civic"
  | "accident"
  | "crime"
  | "politics"
  | "culture"
  | "business"
  | "sport"
  | "other";

export const TOPICS = [
  "power_cut",
  "water_supply",
  "weather",
  "traffic",
  "jobs",
  "education",
  "health",
  "civic",
  "accident",
  "crime",
  "politics",
  "culture",
  "business",
  "sport",
  "other",
] as const satisfies readonly Topic[];
export const TopicSchema = z.enum(TOPICS) satisfies z.ZodType<Topic>;

export type RiskTier = "R0_ROUTINE" | "R1_STANDARD" | "R2_SENSITIVE";
export const RiskTierSchema = z.enum(["R0_ROUTINE", "R1_STANDARD", "R2_SENSITIVE"]) satisfies z.ZodType<RiskTier>;

export type SensitiveCategory =
  | "crime"
  | "death"
  | "suicide"
  | "sexual_offence"
  | "minor"
  | "communal"
  | "election"
  | "allegation"
  | "health_claim"
  | "disaster"
  | "graphic";
export const SensitiveCategorySchema = z.enum([
  "crime",
  "death",
  "suicide",
  "sexual_offence",
  "minor",
  "communal",
  "election",
  "allegation",
  "health_claim",
  "disaster",
  "graphic",
]) satisfies z.ZodType<SensitiveCategory>;

export type FlagOrigin = "rule" | "ai" | "editor";

export type RiskFlag = {
  category: SensitiveCategory;
  origin: FlagOrigin;
  detail: string;
};

export const RiskFlagSchema = z.strictObject({
  category: SensitiveCategorySchema,
  origin: z.enum(["rule", "ai", "editor"]),
  detail: z.string().max(300),
}) satisfies z.ZodType<RiskFlag>;

// ---------------------------------------------------------------- verification

export type VerificationLevel = "V0_UNVERIFIED" | "V1_CORROBORATED" | "V2_OFFICIAL" | "V3_EDITOR_ATTESTED";
export const VerificationLevelSchema = z.enum([
  "V0_UNVERIFIED",
  "V1_CORROBORATED",
  "V2_OFFICIAL",
  "V3_EDITOR_ATTESTED",
]) satisfies z.ZodType<VerificationLevel>;

/** Deliberately no "ai" variant: model output can raise risk flags, it can never create evidence. */
export type VerificationEvidence =
  | { kind: "official_source"; sourceItemId: SourceItemId }
  | { kind: "independent_corroboration"; sourceItemIds: readonly [SourceItemId, SourceItemId, ...SourceItemId[]] }
  | { kind: "editor_attestation"; editorLogin: GitHubLogin; method: string; attestedAt: IsoDateTime };

export const VerificationEvidenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("official_source"), sourceItemId: SourceItemIdSchema }),
  z.strictObject({
    kind: z.literal("independent_corroboration"),
    sourceItemIds: z.tuple([SourceItemIdSchema, SourceItemIdSchema], SourceItemIdSchema).readonly(),
  }),
  z.strictObject({
    kind: z.literal("editor_attestation"),
    editorLogin: GitHubLoginSchema,
    method: z.string().min(10).max(500),
    attestedAt: IsoDateTimeSchema,
  }),
]) satisfies z.ZodType<VerificationEvidence>;

// ---------------------------------------------------------------- stories

export type StoryStatus =
  | "collected"
  | "discarded"
  | "triaged"
  | "awaiting_caption"
  | "in_review"
  | "approved"
  | "on_hold"
  | "rejected"
  | "expired"
  | "scheduled"
  | "published"
  | "publish_failed"
  | "publish_unknown"
  | "retracted";

export const STORY_STATUSES = [
  "collected",
  "discarded",
  "triaged",
  "awaiting_caption",
  "in_review",
  "approved",
  "on_hold",
  "rejected",
  "expired",
  "scheduled",
  "published",
  "publish_failed",
  "publish_unknown",
  "retracted",
] as const satisfies readonly StoryStatus[];
export const StoryStatusSchema = z.enum(STORY_STATUSES) satisfies z.ZodType<StoryStatus>;

export type Story = {
  id: StoryId;
  status: StoryStatus;
  /** Optimistic-concurrency counter, incremented on every persisted change. */
  version: number;
  topic: Topic;
  placeTags: readonly string[];
  riskTier: RiskTier;
  riskFlags: readonly RiskFlag[];
  disputed: boolean;
  /** Higher is more urgent. Derived from topic and freshness. */
  priority: number;
  firstSeenAt: IsoDateTime;
  updatedAt: IsoDateTime;
  /** After this time the story is stale and must not be published (for example, a power cut that has ended). */
  expiresAt?: IsoDateTime;
};

export const StorySchema = z.strictObject({
  id: StoryIdSchema,
  status: StoryStatusSchema,
  version: z.int().min(0),
  topic: TopicSchema,
  placeTags: z.array(z.string().min(1)).readonly(),
  riskTier: RiskTierSchema,
  riskFlags: z.array(RiskFlagSchema).readonly(),
  disputed: z.boolean(),
  priority: z.number(),
  firstSeenAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema.exactOptional(),
}) satisfies z.ZodType<Story>;

// ---------------------------------------------------------------- drafts

export type DraftOrigin = "manual" | "template";

export type DraftRevision = {
  id: DraftId;
  storyId: StoryId;
  revision: number;
  revisionHash: Sha256Hex;
  headlineTa: string;
  captionTa: string;
  hashtags: readonly string[];
  altText: string;
  sourceCreditTa: string;
  templateVersion: string;
  renderKey?: string;
  renderSha256?: Sha256Hex;
  origin: DraftOrigin;
  createdAt: IsoDateTime;
};

export const DraftRevisionSchema = z.strictObject({
  id: DraftIdSchema,
  storyId: StoryIdSchema,
  revision: z.int().min(1),
  revisionHash: Sha256HexSchema,
  headlineTa: z.string().min(1).max(120),
  captionTa: z.string().min(1).max(2200),
  hashtags: z.array(z.string().regex(/^#[\p{L}\p{M}\p{N}_]+$/u)).max(30).readonly(),
  altText: z.string().min(1).max(1000),
  sourceCreditTa: z.string().min(1).max(200),
  templateVersion: z.string().min(1),
  renderKey: z.string().regex(/^[\x21-\x7e]+$/).exactOptional(),
  renderSha256: Sha256HexSchema.exactOptional(),
  origin: z.enum(["manual", "template"]),
  createdAt: IsoDateTimeSchema,
}) satisfies z.ZodType<DraftRevision>;

// ---------------------------------------------------------------- editorial decisions

export type DecisionKind =
  | "caption"
  | "headline"
  | "approve"
  | "approve_sensitive"
  | "schedule"
  | "attest"
  | "hold"
  | "unhold"
  | "reject"
  | "retract"
  | "killswitch_on"
  | "killswitch_off";

export type EditorialDecision = {
  storyId: StoryId;
  kind: DecisionKind;
  editorLogin: GitHubLogin;
  githubCommentId: number;
  /** Full revision hash the decision refers to, for approvals. */
  revisionHash?: Sha256Hex;
  reason?: string;
  scheduledFor?: IsoDateTime;
  createdAt: IsoDateTime;
};

// ---------------------------------------------------------------- publications

export type PublicationStatus =
  | "pending"
  | "container_created"
  | "publish_requested"
  | "published"
  | "publish_failed"
  | "publish_unknown"
  | "cancelled";

export const PublicationStatusSchema = z.enum([
  "pending",
  "container_created",
  "publish_requested",
  "published",
  "publish_failed",
  "publish_unknown",
  "cancelled",
]) satisfies z.ZodType<PublicationStatus>;

export type Publication = {
  id: PublicationId;
  storyId: StoryId;
  draftId: DraftId;
  idempotencyKey: Sha256Hex;
  status: PublicationStatus;
  scheduledFor: IsoDateTime;
  attempts: number;
  containerId?: string;
  containerCreatedAt?: IsoDateTime;
  publishRequestedAt?: IsoDateTime;
  mediaId?: string;
  permalink?: string;
  nextAttemptAt?: IsoDateTime;
  leaseOwner?: string;
  leaseExpiresAt?: IsoDateTime;
  publishedAt?: IsoDateTime;
  lastError?: string;
};
