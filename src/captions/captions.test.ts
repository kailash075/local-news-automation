import { describe, expect, it } from "vitest";
import { formatTamilDate, formatTamilTime, istDateKey, istMinuteOfDay } from "../graphics/tamil-date.ts";
import { CardInputSchema } from "../graphics/templates.ts";
import { assembleCaptionBody, composeCaption, hashtagsFor } from "./caption.ts";
import { PowerCutFactsSchema, draftPowerCut, type PowerCutFacts } from "./power-cut.ts";
import { tamilLetterShare, validateCaption } from "./validate.ts";

const facts: PowerCutFacts = {
  date: "2026-10-31",
  startTime: "09:00",
  endTime: "17:00",
  placeTa: "பெருந்துறை",
  areasTa: ["சிப்காட்", "விஜயமங்கலம்", "திங்களூர்"],
  sourceNameTa: "மின் பகிர்மானக் கழகம், ஈரோடு",
};

describe("Tamil dates and times (IST)", () => {
  it("formats the date in IST even when UTC is the previous day", () => {
    expect(formatTamilDate(new Date("2026-10-30T20:00:00Z"))).toBe("31 அக்டோபர் 2026");
    expect(istDateKey(new Date("2026-10-30T20:00:00Z"))).toBe("2026-10-31");
  });
  it("formats spoken-style times", () => {
    expect(formatTamilTime("09:00")).toBe("காலை 9 மணி");
    expect(formatTamilTime("17:30")).toBe("மாலை 5.30 மணி");
    expect(formatTamilTime("13:00")).toBe("மதியம் 1 மணி");
    expect(formatTamilTime("21:00")).toBe("இரவு 9 மணி");
    expect(() => formatTamilTime("25:00")).toThrow();
  });
  it("gives minutes since IST midnight", () => {
    expect(istMinuteOfDay(new Date("2026-10-30T02:30:00Z"))).toBe(8 * 60);
  });
});

describe("power-cut template", () => {
  const draft = draftPowerCut(facts, new Date("2026-10-30T06:00:00Z"));

  it("produces a caption that passes every house check", () => {
    const report = validateCaption({ headlineTa: draft.headlineTa, caption: draft.fullCaption, altText: draft.altText, factText: draft.factText });
    expect(report.problems).toEqual([]);
    expect(report.stats.hashtags).toBeLessThanOrEqual(5);
  });
  it("attributes the notice and lists every area", () => {
    expect(draft.fullCaption).toContain("தகவல்: மின் பகிர்மானக் கழகம், ஈரோடு");
    expect(draft.fullCaption).toContain("அறிவித்துள்ளது");
    for (const area of facts.areasTa) expect(draft.fullCaption).toContain(area);
    expect(draft.fullCaption).toContain("காலை 9 மணி முதல் மாலை 5 மணி வரை");
  });
  it("produces a valid card", () => {
    expect(CardInputSchema.safeParse(draft.card).success).toBe(true);
    expect(draft.card.template).toBe("alert");
  });
  it("rejects facts where the shutdown ends before it starts", () => {
    expect(PowerCutFactsSchema.safeParse({ ...facts, startTime: "18:00" }).success).toBe(false);
  });
});

describe("validateCaption", () => {
  const base = {
    headlineTa: "ஈரோட்டில் குடிநீர் விநியோக நேரம் மாற்றம்",
    caption: composeCaption({
      captionTa: assembleCaptionBody({
        headlineTa: "ஈரோட்டில் குடிநீர் விநியோக நேரம் மாற்றம்",
        factLines: ["கிழக்கு மண்டலத்தில் 2 நாட்கள் மாற்றம் என்று மாநகராட்சி அறிவித்துள்ளது."],
        placeTa: "ஈரோடு",
        dateTa: "30 அக்டோபர் 2026",
      }),
      sourceCreditTa: "தகவல்: ஈரோடு மாநகராட்சி",
      hashtags: hashtagsFor("water_supply"),
    }),
    altText: "குடிநீர் விநியோக அறிவிப்பு அட்டை",
  };

  it("accepts a well-formed caption", () => {
    expect(validateCaption(base).problems).toEqual([]);
  });
  it("rejects links, mentions and too many hashtags", () => {
    const bad = `${base.caption}\nhttps://example.com @someone #a #b #c`;
    const problems = validateCaption({ ...base, caption: bad }).problems.join("\n");
    expect(problems).toContain("links");
    expect(problems).toContain("@-mentions");
    expect(problems).toContain("hashtags");
  });
  it("rejects sensational words and exclamation headlines", () => {
    const problems = validateCaption({ ...base, headlineTa: "பரபரப்பு! ஈரோட்டில் சம்பவம்" }).problems.join("\n");
    expect(problems).toContain("பரபரப்பு");
    expect(problems).toContain("exclamation");
  });
  it("rejects a number that is not in the facts", () => {
    const problems = validateCaption({ ...base, factText: "கிழக்கு மண்டலம், 3 நாட்கள்" }).problems;
    expect(problems).toContain('number "2" is not in the facts');
  });
  it("requires a mostly Tamil caption", () => {
    expect(tamilLetterShare("Erode news update today")).toBe(0);
    expect(validateCaption({ ...base, caption: "Erode water timing changed. தகவல்: x" }).ok).toBe(false);
  });
  it("requires the source credit line", () => {
    expect(validateCaption({ ...base, caption: base.caption.replace("தகவல்:", "") }).problems.join()).toContain("source credit");
  });
});
