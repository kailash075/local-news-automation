import { ERODE_KEY, ERODE_PLACES, NEIGHBOUR_PLACES, type Place } from "../config/gazetteer.ts";
import type { Source } from "../domain/types.ts";
import { normaliseForStorage, stripZeroWidth } from "./normalise.ts";

export type RelevanceAssessment = {
  relevant: boolean;
  /** Erode places named, canonical English keys, strong names first. */
  places: readonly string[];
  /** Places outside the district that are named. */
  neighbours: readonly string[];
  reason: string;
};

type Strength = "strong" | "weak" | "none";

const TAMIL_CHAR = /[\u0B80-\u0BFF]/u;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Tamil stem at the start of a word (any suffix allowed, so inflected forms match). */
const hasTamilStem = (text: string, stem: string): boolean => {
  let from = 0;
  for (;;) {
    const at = text.indexOf(stem, from);
    if (at === -1) return false;
    const before = at === 0 ? "" : text.charAt(at - 1);
    if (before === "" || !TAMIL_CHAR.test(before)) return true;
    from = at + 1;
  }
};

/** English name as a whole word, case-sensitive. */
const hasEnglishWord = (text: string, word: string): boolean =>
  new RegExp(`(?<![A-Za-z])${escapeRegExp(word)}(?![A-Za-z])`).test(text);

const PLACE_PREFIX = /(?:^|[^A-Za-z])(?:in|at|from|near|of|around|across|to|including|In|At|From|Near|Of|Around|Across|To|Including)\s+$/;
const PLACE_SUFFIX =
  /^(?:\s*[:,(|]|\s+[-–—]\s|-based|'s\s|\s+(?:district|District|city|City|Corporation|corporation|Municipal|Collector|collector|police|Police|SP|railway|Railway|Junction|junction|bus|Bus|town|Town|East|West|North|South|constituency|Constituency|Lok|MP|MLA|GH|Government|Medical|market|Market|news|News|division|Division|circle|Circle|range|Range|region|Region|area|Area|taluk|Taluk|and|&)(?![A-Za-z]))/;

/**
 * English "Erode" is also a verb ("costs erode margins", "Rising Costs Erode Margins" in title case),
 * so it counts only with place context: "in Erode", "Erode district", "Erode:", "Salem, Erode" and similar.
 * "to Erode" counts as a place too ("bus to Erode"); a title-case headline like "Plan to Erode Rights" is the accepted
 * false positive of this rule, and an editor discards it.
 */
export const mentionsErodeInEnglish = (text: string): boolean => {
  const re = /(?<![A-Za-z])Erode(?![A-Za-z])/g;
  for (const match of text.matchAll(re)) {
    const at = match.index;
    const before = text.slice(Math.max(0, at - 16), at);
    const after = text.slice(at + match[0].length, at + match[0].length + 32);
    if (PLACE_SUFFIX.test(after)) return true;
    if (PLACE_PREFIX.test(before)) return true;
    if (/,\s*$/.test(before)) return true;
    // "Erode" ending the text or a sentence ("... including Erode."); the verb needs an object after it.
    if (/^\s*(?:[.!?]|$)/.test(after)) return true;
  }
  return false;
};

const strengthOf = (text: string, place: Place): Strength => {
  if (place.ta.some((stem) => hasTamilStem(text, stem))) return "strong";
  if (place.key === ERODE_KEY && mentionsErodeInEnglish(text)) return "strong";
  if (place.en.some((word) => hasEnglishWord(text, word))) return "strong";
  if ((place.weakTa ?? []).some((stem) => hasTamilStem(text, stem))) return "weak";
  if ((place.weakEn ?? []).some((word) => hasEnglishWord(text, word))) return "weak";
  return "none";
};

/**
 * Is this item about Erode district? Lessons from the Coimbatore 360 pipeline:
 * - an item naming only places in other districts is rejected, even from an Erode-specific page;
 * - an item naming an Erode place and a neighbouring place is kept (a road or bus route to Tiruppur is still Erode news);
 * - ambiguous names (Gobi, Sathy, Sivagiri ...) never make an item relevant on their own.
 */
export const assessRelevance = (text: string, source: Pick<Source, "erodeSpecific">): RelevanceAssessment => {
  const t = stripZeroWidth(normaliseForStorage(text));
  const strong: string[] = [];
  const weak: string[] = [];
  for (const place of ERODE_PLACES) {
    const s = strengthOf(t, place);
    if (s === "strong") strong.push(place.key);
    else if (s === "weak") weak.push(place.key);
  }
  const neighbours: string[] = [];
  for (const place of NEIGHBOUR_PLACES) {
    if (strengthOf(t, place) === "strong") neighbours.push(place.key);
  }
  const places = [...strong, ...weak];

  if (strong.length > 0) {
    const also = neighbours.length > 0 ? `; also names ${neighbours.join(", ")}` : "";
    return { relevant: true, places, neighbours, reason: `names Erode place(s): ${strong.join(", ")}${also}` };
  }
  if (neighbours.length > 0) {
    return {
      relevant: false,
      places,
      neighbours,
      reason: `names only places outside Erode district: ${neighbours.join(", ")}`,
    };
  }
  if (source.erodeSpecific) {
    return { relevant: true, places, neighbours, reason: "Erode-specific source and no other district named" };
  }
  if (weak.length > 0) {
    return {
      relevant: false,
      places,
      neighbours,
      reason: `only ambiguous place names (${weak.join(", ")}); needs an Erode-specific source or an editor`,
    };
  }
  return { relevant: false, places, neighbours, reason: "no Erode place named" };
};
