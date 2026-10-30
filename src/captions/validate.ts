import { LIMITS } from "./caption.ts";

export type CaptionCheckInput = {
  headlineTa: string;
  caption: string;
  altText: string;
  /** Text of the facts the caption was written from. When given, every number in the caption must appear in it. */
  factText?: string;
};

export type CaptionReport = {
  ok: boolean;
  problems: readonly string[];
  stats: { chars: number; hashtags: number; mentions: number; tamilShare: number };
};

const HASHTAG = /#[\p{L}\p{M}\p{N}_]+/gu;
const MENTION = /(?:^|[^\p{L}\p{N}_.])@[A-Za-z0-9._]+/gu;
const URL_LIKE = /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|in|org|net|gov|nic)\b/iu;
const NUMBER = /\d+(?:[.,:]\d+)*/gu;
const BANNED = ["பரபரப்பு", "அதிர்ச்சி", "வைரல்", "shocking", "viral", "must watch"] as const;

/** Share of Tamil-script letters among all letters, ignoring hashtags. */
export const tamilLetterShare = (text: string): number => {
  const withoutTags = text.replace(HASHTAG, " ");
  const letters = withoutTags.match(/[\p{L}\p{M}]/gu) ?? [];
  if (letters.length === 0) return 0;
  const tamil = letters.filter((ch) => /\p{Script=Tamil}/u.test(ch)).length;
  return tamil / letters.length;
};

export const validateCaption = (input: CaptionCheckInput): CaptionReport => {
  const problems: string[] = [];
  const caption = input.caption.normalize("NFC");
  const hashtags = caption.match(HASHTAG) ?? [];
  const mentions = caption.match(MENTION) ?? [];
  const tamilShare = tamilLetterShare(caption);

  if (caption.length > LIMITS.instagramCaptionChars) problems.push(`caption is ${caption.length} characters; Instagram allows ${LIMITS.instagramCaptionChars}`);
  else if (caption.length > LIMITS.houseCaptionChars) problems.push(`caption is ${caption.length} characters; house limit is ${LIMITS.houseCaptionChars}`);
  if (hashtags.length > LIMITS.houseHashtags) problems.push(`${hashtags.length} hashtags; house limit is ${LIMITS.houseHashtags}`);
  if (mentions.length > LIMITS.houseMentions) problems.push("@-mentions are not allowed (house policy)");
  if (URL_LIKE.test(caption)) problems.push("links are not allowed in captions");
  if (tamilShare < LIMITS.minTamilLetterShare) problems.push(`Tamil letters are ${Math.round(tamilShare * 100)}% of the text; at least ${LIMITS.minTamilLetterShare * 100}% required`);
  if (!caption.includes("தகவல்:")) problems.push('source credit line "தகவல்: …" is missing');

  const headline = input.headlineTa.normalize("NFC");
  if (headline.length > LIMITS.houseHeadlineChars) problems.push(`headline is ${headline.length} characters; house limit is ${LIMITS.houseHeadlineChars}`);
  if (headline.includes("!")) problems.push("no exclamation marks in headlines");
  if (headline.includes("?")) problems.push("no question headlines");

  const lower = `${headline}\n${caption}`.toLowerCase();
  for (const word of BANNED) if (lower.includes(word)) problems.push(`banned word: ${word}`);

  if (input.altText.trim() === "") problems.push("alt text is empty");
  if (input.altText.length > LIMITS.instagramAltTextChars) problems.push(`alt text is ${input.altText.length} characters; Instagram allows ${LIMITS.instagramAltTextChars}`);

  if (input.factText !== undefined) {
    const facts = input.factText.normalize("NFC");
    // The 📍 footer carries the posting date, which is not a claim from the sources.
    const captionBody = caption
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("📍"))
      .join("\n")
      .replace(HASHTAG, " ");
    for (const n of new Set(captionBody.match(NUMBER) ?? [])) {
      if (!facts.includes(n)) problems.push(`number "${n}" is not in the facts`);
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    stats: { chars: caption.length, hashtags: hashtags.length, mentions: mentions.length, tamilShare },
  };
};
