import { graphemes, normaliseForComparison } from "./normalise.ts";

/**
 * MinHash over grapheme 3-grams, for near-duplicate detection of Tamil and English titles and excerpts.
 * Deterministic: the same text always gives the same signature, across runs and machines.
 */

export const SIGNATURE_SIZE = 128;

/** Grapheme 3-grams of the comparison form. Texts shorter than three graphemes give one shingle (or none when empty). */
export const shingles = (text: string): ReadonlySet<string> => {
  const g = graphemes(normaliseForComparison(text));
  const out = new Set<string>();
  if (g.length === 0) return out;
  if (g.length < 3) {
    out.add(g.join(""));
    return out;
  }
  for (let i = 0; i + 3 <= g.length; i += 1) out.add(`${g[i] ?? ""}${g[i + 1] ?? ""}${g[i + 2] ?? ""}`);
  return out;
};

/** FNV-1a over UTF-16 code units, 32-bit unsigned. */
const fnv1a = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

/** MurmurHash3 finaliser: a cheap, well-mixed 32-bit permutation. */
const fmix32 = (x: number): number => {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
};

/** Fixed per-position seeds from a seeded generator (mulberry32), so signatures never change between releases. */
const SEEDS: readonly number[] = (() => {
  let state = 0x5eed_e40d;
  const seeds: number[] = [];
  for (let i = 0; i < SIGNATURE_SIZE; i += 1) {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    seeds.push((t ^ (t >>> 14)) >>> 0);
  }
  return seeds;
})();

export const signatureOfShingles = (set: ReadonlySet<string>): Uint32Array => {
  const sig = new Uint32Array(SIGNATURE_SIZE).fill(0xffffffff);
  for (const shingle of set) {
    const base = fnv1a(shingle);
    for (let i = 0; i < SIGNATURE_SIZE; i += 1) {
      const v = fmix32(base ^ (SEEDS[i] ?? 0));
      if (v < (sig[i] ?? 0xffffffff)) sig[i] = v;
    }
  }
  return sig;
};

export const minhashSignature = (text: string): Uint32Array => signatureOfShingles(shingles(text));

/** Estimated Jaccard similarity: the share of equal positions. Two empty texts are not similar. */
export const estimateJaccard = (a: Uint32Array, b: Uint32Array): number => {
  if (a.length !== b.length || a.length === 0) throw new Error("signatures must have the same, non-zero length");
  let equal = 0;
  let allEmpty = true;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === b[i]) equal += 1;
    if (a[i] !== 0xffffffff || b[i] !== 0xffffffff) allEmpty = false;
  }
  return allEmpty ? 0 : equal / a.length;
};

/** Exact Jaccard similarity of two shingle sets, for tests and small comparisons. */
export const exactJaccard = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const s of a) if (b.has(s)) inter += 1;
  return inter / (a.size + b.size - inter);
};

/**
 * LSH band keys. With 32 bands of 4 rows, two texts share at least one key with probability 1 - (1 - s^4)^32:
 * about 50% at Jaccard 0.38 and 95% at 0.55. Items sharing a key are candidates for a full comparison.
 */
export const lshBandKeys = (signature: Uint32Array, bands = 32): readonly string[] => {
  if (signature.length % bands !== 0) throw new Error("signature length must be a multiple of the band count");
  const rows = signature.length / bands;
  const keys: string[] = [];
  for (let b = 0; b < bands; b += 1) {
    let h = 0x811c9dc5 ^ b;
    for (let r = 0; r < rows; r += 1) {
      h ^= signature[b * rows + r] ?? 0;
      h = Math.imul(h, 0x01000193);
    }
    keys.push(`${b}:${(h >>> 0).toString(16)}`);
  }
  return keys;
};

/** Little-endian bytes for storage (bytea). */
export const signatureToBytes = (signature: Uint32Array): Uint8Array => {
  const bytes = new Uint8Array(signature.length * 4);
  const view = new DataView(bytes.buffer);
  signature.forEach((v, i) => {
    view.setUint32(i * 4, v, true);
  });
  return bytes;
};

export const signatureFromBytes = (bytes: Uint8Array): Uint32Array => {
  if (bytes.length % 4 !== 0) throw new Error("signature bytes must be a multiple of 4");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sig = new Uint32Array(bytes.length / 4);
  for (let i = 0; i < sig.length; i += 1) sig[i] = view.getUint32(i * 4, true);
  return sig;
};
