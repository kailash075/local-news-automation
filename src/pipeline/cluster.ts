import type { SourceItem, SourceItemId, Story, StoryId } from "../domain/types.ts";
import { estimateJaccard, minhashSignature } from "./minhash.ts";

/**
 * Story clustering: which story does a newly collected item belong to?
 * Pure: takes the recent stories with their items, returns decisions, touches no store.
 * Items in the same batch are compared with each other too (Coimbatore 360 lesson: the same event from two outlets
 * collected in one round must become one story, not two).
 */

export type ClusterOptions = {
  /** At or above this similarity the item joins the story. */
  attachThreshold: number;
  /** From this similarity up to the attach threshold, the story is shown to the editor as a possible duplicate. */
  hintThreshold: number;
  /** Items more than this many days apart are never merged. */
  windowDays: number;
};

export const DEFAULT_CLUSTER_OPTIONS: ClusterOptions = { attachThreshold: 0.55, hintThreshold: 0.35, windowDays: 2 };

export type ExistingStory = { story: Pick<Story, "id">; items: readonly SourceItem[] };

export type PossibleDuplicate = { storyId: StoryId; similarity: number };

export type ClusterDecision = {
  item: SourceItem;
  storyId: StoryId;
  isNewStory: boolean;
  /** Similarity to the story it joined (1 for an exact URL or content match, 0 for a new story). */
  similarity: number;
  possibleDuplicates: readonly PossibleDuplicate[];
};

const DAY_MS = 86_400_000;

const itemTime = (item: SourceItem): number => Date.parse(item.publishedAt ?? item.fetchedAt);

const itemText = (item: SourceItem): string => `${item.title} ${item.excerpt ?? ""}`;

export const clusterItems = (
  items: readonly SourceItem[],
  existing: readonly ExistingStory[],
  newStoryId: () => StoryId,
  options: ClusterOptions = DEFAULT_CLUSTER_OPTIONS,
): readonly ClusterDecision[] => {
  const signatures = new Map<SourceItemId, Uint32Array>();
  const signatureOf = (item: SourceItem): Uint32Array => {
    let sig = signatures.get(item.id);
    if (sig === undefined) {
      sig = minhashSignature(itemText(item));
      signatures.set(item.id, sig);
    }
    return sig;
  };

  const working: { storyId: StoryId; items: SourceItem[] }[] = existing.map((e) => ({ storyId: e.story.id, items: [...e.items] }));
  const decisions: ClusterDecision[] = [];

  for (const item of items) {
    let best: { index: number; similarity: number } | undefined;
    const hints: PossibleDuplicate[] = [];

    working.forEach((candidate, index) => {
      let similarity = 0;
      for (const other of candidate.items) {
        if (Math.abs(itemTime(other) - itemTime(item)) > options.windowDays * DAY_MS) continue;
        const s =
          other.urlHash === item.urlHash || other.contentHash === item.contentHash
            ? 1
            : estimateJaccard(signatureOf(item), signatureOf(other));
        if (s > similarity) similarity = s;
      }
      if (similarity >= options.attachThreshold) {
        if (best === undefined || similarity > best.similarity) best = { index, similarity };
      } else if (similarity >= options.hintThreshold) {
        hints.push({ storyId: candidate.storyId, similarity });
      }
    });

    hints.sort((a, b) => b.similarity - a.similarity);
    const possibleDuplicates = hints.slice(0, 3);
    const target = best === undefined ? undefined : working[best.index];

    if (best !== undefined && target !== undefined) {
      target.items.push(item);
      decisions.push({ item, storyId: target.storyId, isNewStory: false, similarity: best.similarity, possibleDuplicates });
    } else {
      const storyId = newStoryId();
      working.push({ storyId, items: [item] });
      decisions.push({ item, storyId, isNewStory: true, similarity: 0, possibleDuplicates });
    }
  }
  return decisions;
};
