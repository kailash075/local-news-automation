import { describe, expect, it } from "vitest";
import { assessRelevance, mentionsErodeInEnglish } from "./relevance.ts";

const GENERAL = { erodeSpecific: false };
const ERODE_PAGE = { erodeSpecific: true };

describe("assessRelevance", () => {
  it("accepts Tamil ஈரோடு, including inflected forms", () => {
    expect(assessRelevance("ஈரோடு மாவட்டத்தில் கனமழை", GENERAL).relevant).toBe(true);
    const r = assessRelevance("ஈரோட்டில் நாளை மின்தடை", GENERAL);
    expect(r.relevant).toBe(true);
    expect(r.places).toContain("Erode");
  });

  it("accepts inflected taluk names", () => {
    expect(assessRelevance("அந்தியூரில் சந்தை", GENERAL).places).toContain("Anthiyur");
    expect(assessRelevance("சத்தியமங்கலத்தில் யானை", GENERAL).places).toContain("Sathyamangalam");
  });

  it("does not match a place stem inside another word", () => {
    // வெள்ளோட்டம் ("trial run") is not Vellode.
    expect(assessRelevance("புதிய ரயில் வெள்ளோட்டம்", GENERAL).places).not.toContain("Vellode");
  });

  it("regression: an item naming only a neighbouring district is rejected, even from an Erode page", () => {
    const r = assessRelevance("திருப்பூரில் பனியன் நிறுவனங்கள் வேலைநிறுத்தம்", ERODE_PAGE);
    expect(r.relevant).toBe(false);
    expect(r.neighbours).toContain("Tiruppur");
    expect(assessRelevance("Kumarapalayam bridge closed for repairs", ERODE_PAGE).relevant).toBe(false);
  });

  it("regression: an item naming an Erode place and a neighbour is kept (the Avinashi Road case)", () => {
    const r = assessRelevance("ஈரோடு - திருப்பூர் சாலையில் போக்குவரத்து மாற்றம்", GENERAL);
    expect(r.relevant).toBe(true);
    expect(r.places).toContain("Erode");
    expect(r.neighbours).toContain("Tiruppur");
    expect(assessRelevance("Perundurai to Avinashi road widening begins", GENERAL).relevant).toBe(true);
  });

  it("regression: the English verb 'erode' is ignored", () => {
    expect(assessRelevance("Rising costs erode farmers' margins", GENERAL).relevant).toBe(false);
    expect(assessRelevance("Floods eroded the river bank", GENERAL).relevant).toBe(false);
    expect(assessRelevance("Inflation erodes savings", GENERAL).relevant).toBe(false);
    expect(assessRelevance("Rising Costs Erode Margins", GENERAL).relevant).toBe(false);
  });

  it("accepts English Erode with place context", () => {
    expect(mentionsErodeInEnglish("Erode district to get new bus stand")).toBe(true);
    expect(mentionsErodeInEnglish("Heavy rain in Erode")).toBe(true);
    expect(mentionsErodeInEnglish("Erode: Power shutdown on Thursday")).toBe(true);
    expect(mentionsErodeInEnglish("Salem, Erode and Namakkal get rain")).toBe(true);
    expect(mentionsErodeInEnglish("Erode police arrest two")).toBe(true);
    expect(mentionsErodeInEnglish("Erode")).toBe(true);
    expect(mentionsErodeInEnglish("erode trust")).toBe(false);
  });

  it("an Erode-specific source passes when no other district is named", () => {
    const r = assessRelevance("மாநகராட்சி குறைதீர் கூட்டம் நாளை நடைபெறுகிறது", ERODE_PAGE);
    expect(r.relevant).toBe(true);
    expect(r.reason).toMatch(/Erode-specific/);
  });

  it("ambiguous names alone do not make a general item relevant", () => {
    const r = assessRelevance("Gobi manchurian festival held", GENERAL);
    expect(r.relevant).toBe(false);
    expect(r.places).toContain("Gobichettipalayam");
  });

  it("statewide items need a place match", () => {
    expect(assessRelevance("Chief Minister announces new scheme in Chennai", GENERAL).relevant).toBe(false);
    expect(assessRelevance("Rain alert for 12 districts including Erode", GENERAL).relevant).toBe(true);
  });
});
