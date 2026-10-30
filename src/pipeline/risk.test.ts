import { describe, expect, it } from "vitest";
import { GitHubLoginSchema, type RiskFlag } from "../domain/types.ts";
import { assessRuleRisk, baseTierForTopic, finalTier, maxTier, requestLowerTier, ruleFlags } from "./risk.ts";

const editor = GitHubLoginSchema.parse("kailash075");
const categories = (text: string): string[] => ruleFlags(text).map((f) => f.category);

describe("ruleFlags", () => {
  it("flags R2 categories in Tamil and English", () => {
    expect(categories("கஞ்சா விற்ற இருவர் கைது")).toContain("crime");
    expect(categories("விபத்தில் இளைஞர் உயிரிழப்பு")).toContain("death");
    expect(categories("Youth killed in road accident")).toContain("death");
    expect(categories("போக்சோ வழக்கில் ஒருவர் கைது")).toEqual(expect.arrayContaining(["crime", "sexual_offence"]));
    expect(categories("சிறுமி மீட்பு")).toContain("minor");
    expect(categories("ஆர்ப்பாட்டம் நடத்திய விவசாயிகள்")).toContain("election");
    expect(categories("Dengue outbreak reported")).toContain("health_claim");
    expect(categories("தீ விபத்தில் கடை சேதம்")).toContain("disaster");
  });

  it("avoids known false positives", () => {
    // சாதித்த = "achieved", not சாதி = "caste"; பலித்தது = "came true", not பலி = "killed".
    expect(categories("மாநில அளவில் சாதித்த மாணவிகள்")).not.toContain("communal");
    expect(categories("கனவு பலித்தது")).not.toContain("death");
    expect(categories("சாதி மோதல்")).toContain("communal");
    expect(categories("Bus service resumes")).toEqual([]);
  });

  it("all rule flags have origin rule", () => {
    expect(ruleFlags("murder case filed").every((f) => f.origin === "rule")).toBe(true);
  });
});

describe("tiers", () => {
  it("routine notices are R0, general news R1, crime and politics R2 by topic", () => {
    expect(baseTierForTopic("power_cut")).toBe("R0_ROUTINE");
    expect(baseTierForTopic("accident")).toBe("R1_STANDARD");
    expect(baseTierForTopic("crime")).toBe("R2_SENSITIVE");
    expect(baseTierForTopic("politics")).toBe("R2_SENSITIVE");
  });

  it("a sensitive keyword raises a routine topic to R2", () => {
    expect(assessRuleRisk("மின்தடை அறிவிப்பு", "power_cut").tier).toBe("R0_ROUTINE");
    expect(assessRuleRisk("மின் கம்பி அறுந்து விழுந்து ஒருவர் உயிரிழப்பு", "power_cut").tier).toBe("R2_SENSITIVE");
  });

  it("a classifier failure is R2", () => {
    const r = assessRuleRisk("anything", "power_cut", () => {
      throw new Error("boom");
    });
    expect(r).toEqual({ tier: "R2_SENSITIVE", flags: [], classifierFailed: true });
    expect(finalTier({ topic: "power_cut", flags: [], disputed: false, classifierFailed: true })).toBe("R2_SENSITIVE");
  });

  it("maxTier picks the highest", () => {
    expect(maxTier("R0_ROUTINE", "R2_SENSITIVE", "R1_STANDARD")).toBe("R2_SENSITIVE");
    expect(maxTier()).toBe("R0_ROUTINE");
  });
});

describe("finalTier", () => {
  const aiFlag: RiskFlag = { category: "allegation", origin: "ai", detail: "names a private person" };
  const ruleFlag: RiskFlag = { category: "crime", origin: "rule", detail: "keyword: கைது" };

  it("AI flags can only raise the tier", () => {
    expect(finalTier({ topic: "power_cut", flags: [aiFlag], disputed: false })).toBe("R2_SENSITIVE");
    expect(finalTier({ topic: "crime", flags: [], disputed: false })).toBe("R2_SENSITIVE");
  });

  it("disputed always forces R2, even with an editor override", () => {
    const override = requestLowerTier("R2_SENSITIVE", "R0_ROUTINE", editor, "keyword false positive: கைது in a name");
    if (!override.ok) throw new Error("expected override");
    expect(finalTier({ topic: "power_cut", flags: [ruleFlag], disputed: true, override: override.value })).toBe("R2_SENSITIVE");
  });

  it("an editor override lowers only the rule side; AI flags still raise", () => {
    const override = requestLowerTier("R2_SENSITIVE", "R0_ROUTINE", editor, "keyword false positive: கைது in a name");
    if (!override.ok) throw new Error("expected override");
    expect(finalTier({ topic: "power_cut", flags: [ruleFlag], disputed: false, override: override.value })).toBe("R0_ROUTINE");
    expect(finalTier({ topic: "power_cut", flags: [ruleFlag, aiFlag], disputed: false, override: override.value })).toBe("R2_SENSITIVE");
  });

  it("lowering a tier needs a reason and a lower target", () => {
    expect(requestLowerTier("R2_SENSITIVE", "R1_STANDARD", editor, " ")).toEqual({ ok: false, error: "reason_required" });
    expect(requestLowerTier("R1_STANDARD", "R2_SENSITIVE", editor, "this is a long enough reason")).toEqual({ ok: false, error: "not_lower" });
  });
});
