import { createHash } from "node:crypto";
import { uuidv7 } from "../../src/lib/ids.ts";
import type { NewSourceItem } from "../../src/domain/ports.ts";
import {
  DraftIdSchema,
  DraftRevisionSchema,
  IsoDateTimeSchema,
  PublicationIdSchema,
  Sha256HexSchema,
  SourceIdSchema,
  SourceSchema,
  StoryIdSchema,
  StorySchema,
  type DraftRevision,
  type IsoDateTime,
  type Publication,
  type Sha256Hex,
  type Source,
  type Story,
  type StoryId,
} from "../../src/domain/types.ts";

export const iso = (d: Date): IsoDateTime => IsoDateTimeSchema.parse(d.toISOString());
export const sha = (seed: string): Sha256Hex => Sha256HexSchema.parse(createHash("sha256").update(seed).digest("hex"));

export const TEST_SOURCE_ID = SourceIdSchema.parse("test-erode-notices");

export const testSource = (overrides: Partial<Source> = {}): Source =>
  SourceSchema.parse({
    id: TEST_SOURCE_ID,
    name: "Test Erode notices",
    kind: "rss",
    url: "https://example.org/erode/feed.xml",
    trustTier: "T1_official",
    erodeSpecific: true,
    termsReview: { status: "pending", notes: "", allowedUse: "discovery_only", llmInputAllowed: false },
    fetchIntervalMinutes: 120,
    enabled: false,
    ...overrides,
  });

export const newSourceItem = (seed: string, at: Date, overrides: Partial<NewSourceItem> = {}): NewSourceItem => ({
  sourceId: TEST_SOURCE_ID,
  canonicalUrl: `https://example.org/erode/${encodeURIComponent(seed)}`,
  urlHash: sha(`url:${seed}`),
  title: `ஈரோடு செய்தி ${seed}`,
  language: "ta",
  fetchedAt: iso(at),
  contentHash: sha(`content:${seed}`),
  ...overrides,
});

export const makeStory = (at: Date, overrides: Partial<Story> = {}): Story =>
  StorySchema.parse({
    id: StoryIdSchema.parse(uuidv7(at)),
    status: "collected",
    version: 0,
    topic: "power_cut",
    placeTags: ["ஈரோடு"],
    riskTier: "R0_ROUTINE",
    riskFlags: [],
    disputed: false,
    priority: 1,
    firstSeenAt: iso(at),
    updatedAt: iso(at),
    ...overrides,
  });

export const makeDraft = (storyId: StoryId, at: Date, revision = 1, overrides: Partial<DraftRevision> = {}): DraftRevision =>
  DraftRevisionSchema.parse({
    id: DraftIdSchema.parse(uuidv7(at)),
    storyId,
    revision,
    revisionHash: sha(`draft:${storyId}:${revision}`),
    headlineTa: "ஈரோட்டில் நாளை மின்தடை",
    captionTa: "ஈரோடு நகரின் சில பகுதிகளில் நாளை காலை 9 மணி முதல் மாலை 5 மணி வரை மின்தடை.",
    hashtags: ["#ஈரோடு", "#Erode"],
    altText: "மின்தடை அறிவிப்பு அட்டை",
    sourceCreditTa: "தகவல்: மின்வாரியம்",
    templateVersion: "news-card@1",
    origin: "template",
    createdAt: iso(at),
    ...overrides,
  });

export const makePublication = (
  storyId: StoryId,
  draft: DraftRevision,
  scheduledFor: Date,
  overrides: Partial<Publication> = {},
): Publication => ({
  id: PublicationIdSchema.parse(uuidv7(scheduledFor)),
  storyId,
  draftId: draft.id,
  idempotencyKey: sha(`pub:${storyId}:${draft.revisionHash}`),
  status: "pending",
  scheduledFor: iso(scheduledFor),
  attempts: 0,
  ...overrides,
});
