import type { DraftRevision, Topic } from "../domain/types.ts";

/** Instagram's documented limits and the stricter house limits (editorial policy §8, architecture §5.7). */
export const LIMITS = {
  instagramCaptionChars: 2200,
  instagramHashtags: 30,
  instagramMentions: 20,
  instagramAltTextChars: 1000,
  houseCaptionChars: 1800,
  houseHashtags: 5,
  houseMentions: 0,
  houseHeadlineChars: 70,
  minTamilLetterShare: 0.6,
} as const;

export const BASE_HASHTAGS = ["#ErodeGlitz", "#ஈரோடு", "#Erode", "#ErodeNews"] as const;

/** One topic tag per post; the Coimbatore 360 lesson is that focused tags beat tag stuffing. */
const TOPIC_HASHTAG: Readonly<Record<Topic, string | undefined>> = {
  power_cut: "#PowerCut",
  water_supply: "#Water",
  weather: "#Weather",
  traffic: "#Traffic",
  jobs: "#Jobs",
  education: "#Education",
  health: "#Health",
  civic: "#Civic",
  accident: undefined,
  crime: undefined,
  politics: undefined,
  culture: "#Culture",
  business: "#Business",
  sport: "#Sports",
  other: undefined,
};

export const hashtagsFor = (topic: Topic): readonly string[] => {
  const topicTag = TOPIC_HASHTAG[topic];
  return topicTag === undefined ? [...BASE_HASHTAGS] : [...BASE_HASHTAGS, topicTag];
};

export const FOLLOW_LINE = "ஈரோடு செய்திகளைத் தவறவிடாமல் இருக்க ErodeGlitz பக்கத்தை Follow செய்யுங்கள்";

export type CaptionParts = {
  headlineTa: string;
  /** 2 to 5 short fact sentences, most useful first. */
  factLines: readonly string[];
  placeTa: string;
  dateTa: string;
  /** "திருத்தம்:" or "புதுப்பிப்பு:" for corrections and updates. */
  prefix?: "திருத்தம்:" | "புதுப்பிப்பு:";
};

/**
 * Caption body stored as `DraftRevision.captionTa`. The source credit and hashtags are stored separately and
 * appended by `composeCaption`, so the full caption sent to Instagram is:
 *
 *   <headline>
 *
 *   <fact lines>
 *
 *   📍 <place> | <date>
 *   <follow line>
 *
 *   தகவல்: <source>
 *
 *   <hashtags>
 */
export const assembleCaptionBody = (parts: CaptionParts): string => {
  const headline = parts.prefix === undefined ? parts.headlineTa : `${parts.prefix} ${parts.headlineTa}`;
  return [headline, "", ...parts.factLines, "", `📍 ${parts.placeTa} | ${parts.dateTa}`, FOLLOW_LINE].join("\n");
};

/** The exact caption sent to Instagram. Reconciliation matches published posts on it, so it must be deterministic. */
export const composeCaption = (draft: Pick<DraftRevision, "captionTa" | "sourceCreditTa" | "hashtags">): string =>
  [draft.captionTa.trim(), draft.sourceCreditTa.trim(), draft.hashtags.join(" ")].filter((x) => x !== "").join("\n\n");
