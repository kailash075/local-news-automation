import { uuidv7 } from "../lib/ids.ts";
import type { Clock, StoryAttachment, Stores } from "../domain/ports.ts";
import { transition, type StoryEventType } from "../domain/story-state.ts";
import { StoryIdSchema, type Source, type SourceItem, type Story, type StoryId } from "../domain/types.ts";
import { clusterItems, type ExistingStory } from "../pipeline/cluster.ts";
import { assessFreshness } from "../pipeline/freshness.ts";
import { assessRelevance } from "../pipeline/relevance.ts";
import { assessRuleRisk, finalTier } from "../pipeline/risk.ts";
import { detectTopic, priorityFor } from "../pipeline/topic.ts";
import { toIso } from "../publishing/ist.ts";

export type TriageDeps = {
  stores: Pick<Stores, "sourceItems" | "stories" | "evidence">;
  clock: Clock;
  maxAgeHours: number;
  sourceFor: (id: string) => Source | undefined;
};

export type TriageReport = { items: number; newStories: number; attached: number; discarded: number; lines: readonly string[] };

const BATCH = 200;
const CLUSTER_LOOKBACK_MS = 3 * 24 * 3600_000;

const itemText = (item: SourceItem): string => `${item.title}\n${item.excerpt ?? ""}`;

const apply = (story: Story, events: readonly StoryEventType[], at: Date): Story => {
  let current = story;
  for (const type of events) {
    const next = transition(current, { type, at: toIso(at) });
    if (!next.ok) throw new Error(`story transition ${current.status} -> ${type} refused`);
    current = next.value;
  }
  return current;
};

const buildStory = (id: StoryId, item: SourceItem, places: readonly string[], deps: TriageDeps, now: Date): { story: Story; note: string } => {
  const text = itemText(item);
  const topic = detectTopic(text);
  const risk = assessRuleRisk(text, topic);
  const riskTier = finalTier({ topic, flags: risk.flags, disputed: false, classifierFailed: risk.classifierFailed });
  const publishedAt = item.publishedAt === undefined ? undefined : new Date(item.publishedAt);
  const freshness = assessFreshness({
    text,
    topic,
    ...(publishedAt === undefined ? {} : { publishedAt }),
    firstSeenAt: now,
    now,
    maxAgeHours: deps.maxAgeHours,
  });
  const expiresAt = freshness.status === "stale" ? undefined : freshness.expiresAt;
  const base: Story = {
    id,
    status: "collected",
    version: 0,
    topic,
    placeTags: places,
    riskTier,
    riskFlags: risk.flags,
    disputed: false,
    priority: priorityFor(topic, publishedAt, now),
    firstSeenAt: toIso(now),
    updatedAt: toIso(now),
    ...(expiresAt === undefined ? {} : { expiresAt: toIso(expiresAt) }),
  };
  if (freshness.status === "fresh") {
    return { story: apply(base, ["triage", "shortlist"], now), note: `${topic}, ${riskTier}` };
  }
  return { story: apply(base, ["triage", "discard"], now), note: `discarded: ${freshness.reason}` };
};

/** Evidence derived from sources only: an official source, or two different organisations. Never from AI. */
const refreshEvidence = async (deps: TriageDeps, storyIds: readonly StoryId[]): Promise<void> => {
  if (storyIds.length === 0) return;
  const [itemsByStory, evidenceByStory] = await Promise.all([
    deps.stores.sourceItems.listForStories(storyIds),
    deps.stores.evidence.listForStories(storyIds),
  ]);
  for (const storyId of storyIds) {
    const items = itemsByStory.get(storyId) ?? [];
    const existing = evidenceByStory.get(storyId) ?? [];
    const official = items.find((i) => deps.sourceFor(i.sourceId)?.trustTier === "T1_official");
    if (official !== undefined && !existing.some((e) => e.kind === "official_source")) {
      await deps.stores.evidence.add(storyId, { kind: "official_source", sourceItemId: official.id });
    }
    const bySource = new Map<string, SourceItem>();
    for (const i of items) {
      const kind = deps.sourceFor(i.sourceId)?.kind;
      if (kind !== undefined && kind !== "editor_tip" && !bySource.has(i.sourceId)) bySource.set(i.sourceId, i);
    }
    const [first, second, ...rest] = [...bySource.values()];
    if (first !== undefined && second !== undefined && !existing.some((e) => e.kind === "independent_corroboration")) {
      await deps.stores.evidence.add(storyId, {
        kind: "independent_corroboration",
        sourceItemIds: [first.id, second.id, ...rest.map((i) => i.id)],
      });
    }
  }
};

/**
 * Turns new source items into stories: Erode relevance (neighbour-only items are dropped), clustering with recent
 * stories, topic and rule-based risk, freshness. Items that are not about Erode, or already stale, become discarded
 * stories so they are not looked at again.
 * The new stories and their links are written together at the end, in a few Sheet requests however many items arrived.
 */
export const runTriage = async (deps: TriageDeps): Promise<TriageReport> => {
  const now = deps.clock.now();
  const items = await deps.stores.sourceItems.listUnassigned(BATCH);
  const lines: string[] = [];
  const stories: Story[] = [];
  const attachments: StoryAttachment[] = [];
  const discardedNow: ExistingStory[] = [];
  let newStories = 0;
  let attached = 0;
  let discarded = 0;

  const relevant: SourceItem[] = [];
  const placesByItem = new Map<string, readonly string[]>();
  for (const item of items) {
    const source = deps.sourceFor(item.sourceId);
    const relevance = assessRelevance(itemText(item), { erodeSpecific: source?.erodeSpecific ?? false });
    if (relevance.relevant) {
      relevant.push(item);
      placesByItem.set(item.id, relevance.places);
      continue;
    }
    const id = StoryIdSchema.parse(uuidv7(now));
    const base: Story = {
      id,
      status: "collected",
      version: 0,
      topic: "other",
      placeTags: [],
      riskTier: "R1_STANDARD",
      riskFlags: [],
      disputed: false,
      priority: 0,
      firstSeenAt: toIso(now),
      updatedAt: toIso(now),
    };
    stories.push(apply(base, ["discard"], now));
    attachments.push({ itemId: item.id, storyId: id, relation: "primary" });
    discardedNow.push({ story: { id }, items: [item] });
    discarded += 1;
  }

  // Recent stories in the Sheet, plus the ones just discarded (not written yet), as candidates to join.
  const recent = relevant.length === 0 ? [] : await deps.stores.stories.listRecentWithItems(toIso(new Date(now.getTime() - CLUSTER_LOOKBACK_MS)));
  const existing = [...recent, ...discardedNow];
  const decisions = clusterItems(relevant, existing, () => StoryIdSchema.parse(uuidv7(now)));
  const created = new Set<StoryId>();
  const touched = new Set<StoryId>();
  for (const d of decisions) {
    if (d.isNewStory && !created.has(d.storyId)) {
      const { story, note } = buildStory(d.storyId, d.item, placesByItem.get(d.item.id) ?? [], deps, now);
      stories.push(story);
      attachments.push({ itemId: d.item.id, storyId: d.storyId, relation: "primary" });
      created.add(d.storyId);
      if (story.status === "discarded") discarded += 1;
      else newStories += 1;
      const dupes = d.possibleDuplicates.length === 0 ? "" : ` (possible duplicate of ${d.possibleDuplicates.length} story/stories)`;
      lines.push(`- new story: ${d.item.title.slice(0, 80)} [${note}]${dupes}`);
    } else {
      attachments.push({ itemId: d.item.id, storyId: d.storyId, relation: "corroborating" });
      attached += 1;
    }
    touched.add(d.storyId);
  }
  // Stories before their links, so a link never points at a missing story.
  await deps.stores.stories.insertMany(stories);
  await deps.stores.sourceItems.attachToStories(attachments);
  await refreshEvidence(deps, [...touched]);

  return { items: items.length, newStories, attached, discarded, lines };
};
