import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SourceItemSchema, StoryIdSchema, type SourceItem, type StoryId } from "../domain/types.ts";
import { clusterItems } from "./cluster.ts";
import { normaliseForComparison, sha256Hex } from "./normalise.ts";

const makeItem = (title: string, opts: { url?: string; publishedAt?: string; sourceId?: string } = {}): SourceItem => {
  const url = opts.url ?? `https://example.com/${randomUUID()}`;
  return SourceItemSchema.parse({
    id: randomUUID(),
    sourceId: opts.sourceId ?? "dinamalar-erode",
    canonicalUrl: url,
    urlHash: sha256Hex(url),
    title,
    language: "ta",
    fetchedAt: "2026-10-30T05:00:00.000Z",
    contentHash: sha256Hex(normaliseForComparison(title)),
    ...(opts.publishedAt === undefined ? {} : { publishedAt: opts.publishedAt }),
  });
};

const ids = (): (() => StoryId) => () => StoryIdSchema.parse(randomUUID());

const POWER_CUT = "ஈரோடு மாவட்டம் பெருந்துறை பகுதியில் நாளை காலை 9 மணி முதல் மாலை 5 மணி வரை மின்தடை";
const POWER_CUT_OTHER_OUTLET = "ஈரோடு மாவட்டம் பெருந்துறை பகுதியில் நாளை காலை 9 மணி முதல் மாலை 5 மணி வரை மின் தடை அறிவிப்பு";
const FESTIVAL = "சென்னிமலை முருகன் கோவிலில் கந்த சஷ்டி திருவிழா கொடியேற்றத்துடன் தொடங்கியது";

describe("clusterItems", () => {
  it("attaches a near-duplicate to an existing story", () => {
    const existingId = StoryIdSchema.parse(randomUUID());
    const [d] = clusterItems([makeItem(POWER_CUT_OTHER_OUTLET)], [{ story: { id: existingId }, items: [makeItem(POWER_CUT)] }], ids());
    expect(d?.isNewStory).toBe(false);
    expect(d?.storyId).toBe(existingId);
    expect(d?.similarity).toBeGreaterThanOrEqual(0.55);
  });

  it("regression: the same event from two outlets in one batch becomes one story", () => {
    const decisions = clusterItems([makeItem(POWER_CUT), makeItem(POWER_CUT_OTHER_OUTLET), makeItem(FESTIVAL)], [], ids());
    expect(decisions).toHaveLength(3);
    expect(decisions[0]?.isNewStory).toBe(true);
    expect(decisions[1]?.isNewStory).toBe(false);
    expect(decisions[1]?.storyId).toBe(decisions[0]?.storyId);
    expect(decisions[2]?.isNewStory).toBe(true);
    expect(decisions[2]?.storyId).not.toBe(decisions[0]?.storyId);
  });

  it("an identical URL or content hash attaches with similarity 1", () => {
    const url = "https://example.com/news/1";
    const existingId = StoryIdSchema.parse(randomUUID());
    const [d] = clusterItems(
      [makeItem("completely different words here", { url })],
      [{ story: { id: existingId }, items: [makeItem("original title", { url })] }],
      ids(),
    );
    expect(d).toMatchObject({ storyId: existingId, isNewStory: false, similarity: 1 });
  });

  it("never merges items more than two days apart", () => {
    const existingId = StoryIdSchema.parse(randomUUID());
    const [d] = clusterItems(
      [makeItem(POWER_CUT, { publishedAt: "2026-10-30T05:00:00.000Z" })],
      [{ story: { id: existingId }, items: [makeItem(POWER_CUT, { publishedAt: "2026-10-26T05:00:00.000Z" })] }],
      ids(),
    );
    expect(d?.isNewStory).toBe(true);
  });

  it("reports mid-range similarity as a possible duplicate without merging", () => {
    const existingId = StoryIdSchema.parse(randomUUID());
    const [d] = clusterItems(
      [makeItem(POWER_CUT_OTHER_OUTLET)],
      [{ story: { id: existingId }, items: [makeItem(POWER_CUT)] }],
      ids(),
      { attachThreshold: 0.99, hintThreshold: 0.3, windowDays: 2 },
    );
    expect(d?.isNewStory).toBe(true);
    expect(d?.possibleDuplicates[0]?.storyId).toBe(existingId);
  });
});
