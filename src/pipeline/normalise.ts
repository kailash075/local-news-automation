import { createHash } from "node:crypto";
import { err, ok, type Result } from "../lib/result.ts";
import { Sha256HexSchema, type Language, type Sha256Hex } from "../domain/types.ts";

/**
 * Text and URL normalisation. Tamil syllables are often two code points (consonant plus vowel sign),
 * so anything that counts or cuts text works on grapheme clusters, never on code units.
 */

// Alternation, not a character class: a class containing ZWJ is flagged as misleading.
const ZERO_WIDTH = /\u200B|\u200C|\u200D|\u2060|\uFEFF/g;
const TAMIL_DIGIT = /[\u0BE6-\u0BEF]/g;
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const TAMIL_CHAR = /[\u0B80-\u0BFF]/u;
const LATIN_LETTER = /[A-Za-z]/;

const graphemeSegmenter = new Intl.Segmenter("ta", { granularity: "grapheme" });

export const graphemes = (text: string): string[] =>
  Array.from(graphemeSegmenter.segment(text), (s) => s.segment);

/** Removes zero-width joiner, non-joiner and similar characters. For comparison only: never apply to published text. */
export const stripZeroWidth = (text: string): string => text.replace(ZERO_WIDTH, "");

/** Tamil digits ௦ to ௯ become ASCII 0 to 9. */
export const tamilDigitsToAscii = (text: string): string =>
  text.replace(TAMIL_DIGIT, (d) => String(d.charCodeAt(0) - 0x0be6));

/** Safe for storing and displaying: NFC, no control characters, single spaces. Keeps joiners, which can matter for rendering. */
export const normaliseForStorage = (text: string): string =>
  text.normalize("NFC").replace(CONTROL, " ").replace(/\s+/gu, " ").trim();

/** For hashing, matching and similarity: also drops joiners, converts Tamil digits, lower-cases Latin and removes punctuation. */
export const normaliseForComparison = (text: string): string =>
  tamilDigitsToAscii(stripZeroWidth(normaliseForStorage(text)))
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

/**
 * Share of Tamil letters among Tamil and Latin letters, from 0 to 1, counted in graphemes
 * (கொ is one letter, not two code points). Text without letters gives 0.
 */
export const tamilShare = (text: string): number => {
  let tamil = 0;
  let latin = 0;
  for (const g of graphemes(text)) {
    if (TAMIL_CHAR.test(g)) tamil += 1;
    else if (LATIN_LETTER.test(g)) latin += 1;
  }
  const total = tamil + latin;
  return total === 0 ? 0 : tamil / total;
};

export const guessLanguage = (text: string): Language => {
  let letters = 0;
  for (const ch of text) if (TAMIL_CHAR.test(ch) || LATIN_LETTER.test(ch)) letters += 1;
  if (letters === 0) return "other";
  return tamilShare(text) >= 0.5 ? "ta" : "en";
};

/** Cuts text to at most `maxLength` UTF-16 code units without splitting a grapheme, adding "…" when it cuts. */
export const truncateGraphemes = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) return text;
  const budget = maxLength - 1;
  let out = "";
  for (const g of graphemes(text)) {
    if (out.length + g.length > budget) break;
    out += g;
  }
  return `${out.trimEnd()}…`;
};

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

export const decodeHtmlEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });

/** Plain text from an HTML fragment: drops scripts, styles, comments and tags, decodes entities. */
export const stripHtml = (html: string): string =>
  normaliseForStorage(
    decodeHtmlEntities(
      html
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1\s*>/gi, " ")
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<[^>]*>/g, " "),
    ),
  );

const TRACKING_PARAM = /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|_ga|yclid)$/i;

/**
 * Canonical form used for de-duplication: http(s) only, lower-case host (done by URL), no default port,
 * no tracking parameters, remaining parameters sorted, no fragment.
 */
export const canonicalUrl = (raw: string, base?: string): Result<string, "invalid_url"> => {
  let url: URL;
  try {
    url = base === undefined ? new URL(raw.trim()) : new URL(raw.trim(), base);
  } catch {
    return err("invalid_url");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return err("invalid_url");
  url.hash = "";
  url.username = "";
  url.password = "";
  const kept = [...url.searchParams.entries()].filter(([key]) => !TRACKING_PARAM.test(key));
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = new URLSearchParams(kept).toString();
  return ok(url.toString());
};

export const sha256Hex = (input: string | Uint8Array): Sha256Hex =>
  Sha256HexSchema.parse(createHash("sha256").update(input).digest("hex"));
