import { describe, expect, it } from "vitest";
import {
  SIGNATURE_SIZE,
  estimateJaccard,
  exactJaccard,
  lshBandKeys,
  minhashSignature,
  shingles,
  signatureFromBytes,
  signatureToBytes,
} from "./minhash.ts";

const A = "ஈரோடு மாவட்டம் பெருந்துறை பகுதியில் நாளை காலை 9 மணி முதல் மாலை 5 மணி வரை மின்தடை";
const A_VARIANT = "ஈரோடு மாவட்டம் பெருந்துறை பகுதியில் நாளை காலை 9 மணி முதல் மாலை 5 மணி வரை மின் தடை அறிவிப்பு";
const UNRELATED = "சென்னிமலை முருகன் கோவிலில் கந்த சஷ்டி திருவிழா கொடியேற்றத்துடன் தொடங்கியது";

describe("minhash", () => {
  it("builds grapheme 3-grams of the comparison form", () => {
    expect([...shingles("கொடுமுடி")]).toEqual(["கொடுமு", "டுமுடி"]);
    expect([...shingles("ab")]).toEqual(["ab"]);
    expect(shingles("").size).toBe(0);
  });

  it("is deterministic", () => {
    expect(minhashSignature(A)).toEqual(minhashSignature(A));
    expect(minhashSignature(A)).toHaveLength(SIGNATURE_SIZE);
  });

  it("estimates Jaccard close to the exact value", () => {
    const exact = exactJaccard(shingles(A), shingles(A_VARIANT));
    const estimate = estimateJaccard(minhashSignature(A), minhashSignature(A_VARIANT));
    expect(Math.abs(exact - estimate)).toBeLessThan(0.15);
    expect(estimate).toBeGreaterThan(0.55);
  });

  it("scores unrelated texts low and identical texts 1", () => {
    expect(estimateJaccard(minhashSignature(A), minhashSignature(UNRELATED))).toBeLessThan(0.2);
    expect(estimateJaccard(minhashSignature(A), minhashSignature(A))).toBe(1);
    expect(estimateJaccard(minhashSignature(""), minhashSignature(""))).toBe(0);
  });

  it("gives near-duplicates a shared LSH band key", () => {
    const a = new Set(lshBandKeys(minhashSignature(A)));
    const shared = lshBandKeys(minhashSignature(A_VARIANT)).filter((k) => a.has(k));
    expect(shared.length).toBeGreaterThan(0);
  });

  it("round-trips signatures through bytes", () => {
    const sig = minhashSignature(A);
    const bytes = signatureToBytes(sig);
    expect(bytes).toHaveLength(SIGNATURE_SIZE * 4);
    expect(signatureFromBytes(bytes)).toEqual(sig);
  });

  it("rejects mismatched signatures", () => {
    expect(() => estimateJaccard(new Uint32Array(4), new Uint32Array(8))).toThrow();
    expect(() => lshBandKeys(new Uint32Array(10), 3)).toThrow();
  });
});
