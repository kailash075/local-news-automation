import { describe, expect, it } from "vitest";
import {
  canonicalUrl,
  graphemes,
  guessLanguage,
  normaliseForComparison,
  normaliseForStorage,
  sha256Hex,
  stripHtml,
  stripZeroWidth,
  tamilDigitsToAscii,
  tamilShare,
  truncateGraphemes,
} from "./normalise.ts";

describe("normalise", () => {
  it("converts Tamil digits to ASCII (regression: Tamil digits)", () => {
    expect(tamilDigitsToAscii("௩௦ அக்டோபர் ௨௦௨௬")).toBe("30 அக்டோபர் 2026");
  });

  it("removes zero-width joiners only for comparison", () => {
    const withZwj = "க்‍ஷ";
    expect(stripZeroWidth(withZwj)).toBe("க்ஷ");
    expect(normaliseForStorage(withZwj)).toBe(withZwj);
    expect(normaliseForComparison(withZwj)).toBe("க்ஷ");
  });

  it("composes to NFC and collapses whitespace", () => {
    const decomposed = "ஈரோடு".normalize("NFD");
    expect(normaliseForStorage(`  ${decomposed}\n\t மாவட்டம்  `)).toBe("ஈரோடு மாவட்டம்");
  });

  it("comparison form drops punctuation and lower-cases Latin", () => {
    expect(normaliseForComparison("Erode: Power Cut! ௧௦ AM")).toBe("erode power cut 10 am");
  });

  it("segments Tamil into graphemes, not code points", () => {
    expect("கொ".length).toBe(2); // two code points: consonant plus vowel sign
    expect(graphemes("கொடுமுடி")).toEqual(["கொ", "டு", "மு", "டி"]);
  });

  it("truncates without splitting a grapheme", () => {
    const text = "கொடுமுடி கொடுமுடி";
    const cut = truncateGraphemes(text, 6);
    expect(cut.length).toBeLessThanOrEqual(6);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut).toBe("கொடு…");
    expect(truncateGraphemes("short", 10)).toBe("short");
  });

  it("guesses language from Tamil-script share", () => {
    expect(guessLanguage("ஈரோட்டில் நாளை மின்தடை")).toBe("ta");
    expect(guessLanguage("Power shutdown in Erode tomorrow")).toBe("en");
    expect(guessLanguage("12345 !!!")).toBe("other");
    // Counted in letters (graphemes): ஈ, ரோ, டு are 3 letters against 5 Latin ones.
    expect(tamilShare("ஈரோடு Erode")).toBeCloseTo(3 / 8);
    expect(tamilShare("ஈரோடு மாவட்டம் #Erode")).toBeGreaterThan(0.6);
  });

  it("strips HTML and decodes entities", () => {
    expect(stripHtml("<p>Erode &amp; Bhavani<br/>news<script>alert(1)</script> &#2951;</p>")).toBe("Erode & Bhavani news இ");
  });

  describe("canonicalUrl (regression: utm stripping)", () => {
    it("strips tracking parameters, fragments and default ports, and lower-cases the host", () => {
      const r = canonicalUrl("https://WWW.Example.COM:443/news/a?utm_source=x&b=2&fbclid=y&a=1&gclid=z#top");
      expect(r).toEqual({ ok: true, value: "https://www.example.com/news/a?a=1&b=2" });
    });

    it("resolves relative links against a base", () => {
      expect(canonicalUrl("/erode/1", "https://example.com/list")).toEqual({ ok: true, value: "https://example.com/erode/1" });
    });

    it("rejects non-http URLs and garbage", () => {
      expect(canonicalUrl("javascript:alert(1)").ok).toBe(false);
      expect(canonicalUrl("not a url").ok).toBe(false);
    });
  });

  it("hashes to lower-case hex SHA-256", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
