import { createHash } from "node:crypto";
import { Sha256HexSchema, type Sha256Hex, type StoryId } from "../domain/types.ts";

/** Everything an editor approves. Changing any field produces a new hash, so an old approval no longer applies. */
export type RevisionHashInput = {
  storyId: StoryId;
  revision: number;
  headlineTa: string;
  captionTa: string;
  hashtags: readonly string[];
  altText: string;
  sourceCreditTa: string;
  templateVersion: string;
  /** Absent until the graphic is rendered; a draft without a render cannot be approved for publishing. */
  renderSha256?: Sha256Hex;
  sources: readonly { name: string; url: string }[];
};

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

/** JSON with object keys sorted at every level, so the same content always gives the same bytes. */
export const canonicalJson = (value: Json): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (isJsonArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k] ?? null)}`).join(",")}}`;
};

const isJsonArray = (value: Json): value is readonly Json[] => Array.isArray(value);

export const sha256Hex = (text: string): Sha256Hex =>
  Sha256HexSchema.parse(createHash("sha256").update(text, "utf8").digest("hex"));

export const revisionHash = (input: RevisionHashInput): Sha256Hex =>
  sha256Hex(
    canonicalJson({
      storyId: input.storyId,
      revision: input.revision,
      headlineTa: input.headlineTa,
      captionTa: input.captionTa,
      hashtags: [...input.hashtags],
      altText: input.altText,
      sourceCreditTa: input.sourceCreditTa,
      templateVersion: input.templateVersion,
      renderSha256: input.renderSha256 ?? null,
      sources: input.sources.map((s) => ({ name: s.name, url: s.url })),
    }),
  );

export const SHORT_HASH_LENGTH = 12;

/** The part editors type in commands such as `/approve a1b2c3d4e5f6`. */
export const shortHash = (hash: Sha256Hex): string => hash.slice(0, SHORT_HASH_LENGTH);
