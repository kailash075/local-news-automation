import { describe, expect, it } from "vitest";
import { TOPIC_WEIGHTS, detectTopic, priorityFor, topicMatches } from "./topic.ts";

describe("detectTopic", () => {
  it("detects power cuts in Tamil and English", () => {
    expect(detectTopic("பெருந்துறையில் நாளை மின்தடை")).toBe("power_cut");
    expect(detectTopic("ஈரோடு பகுதியில் மின் நிறுத்தம்")).toBe("power_cut");
    expect(detectTopic("Power shutdown in Erode on Thursday")).toBe("power_cut");
  });

  it("detects other topics", () => {
    expect(detectTopic("குடிநீர் விநியோகம் நிறுத்தம்")).toBe("water_supply");
    expect(detectTopic("ஈரோட்டில் கனமழை")).toBe("weather");
    expect(detectTopic("IMD issues yellow alert")).toBe("weather");
    expect(detectTopic("பவானி அருகே பைக் விபத்து")).toBe("accident");
    expect(detectTopic("கஞ்சா விற்ற இருவர் கைது")).toBe("crime");
    expect(detectTopic("மஞ்சள் விலை உயர்வு")).toBe("business");
    expect(detectTopic("Chennimalai temple car festival")).toBe("culture");
    expect(detectTopic("Nothing to see here")).toBe("other");
  });

  it("picks the highest-weight topic when several match (an accident report mentioning police stays an accident)", () => {
    expect(detectTopic("விபத்து குறித்து போலீசார் விசாரணை")).toBe("accident");
    expect(detectTopic("Power cut notice: corporation announces maintenance")).toBe("power_cut");
  });

  it("matches English keywords as whole words only", () => {
    expect(topicMatches("terrain report").some((m) => m.keyword === "rain")).toBe(false);
    expect(topicMatches("rain today").some((m) => m.keyword === "rain")).toBe(true);
  });
});

describe("priorityFor", () => {
  const now = new Date("2026-10-30T06:00:00Z");

  it("follows the topic order power cut > water > weather > traffic > accident > crime > civic > jobs > education > health > rest", () => {
    const order = ["power_cut", "water_supply", "weather", "traffic", "accident", "crime", "civic", "jobs", "education", "health"] as const;
    for (let i = 1; i < order.length; i += 1) {
      const higher = order[i - 1];
      const lower = order[i];
      if (higher === undefined || lower === undefined) throw new Error("unreachable");
      expect(TOPIC_WEIGHTS[higher]).toBeGreaterThan(TOPIC_WEIGHTS[lower]);
    }
    for (const rest of ["politics", "business", "culture", "sport", "other"] as const) {
      expect(TOPIC_WEIGHTS.health).toBeGreaterThan(TOPIC_WEIGHTS[rest]);
    }
  });

  it("decays with age (half-life 24 h) and treats an unknown time as fresh", () => {
    expect(priorityFor("power_cut", now, now)).toBe(100);
    expect(priorityFor("power_cut", new Date(now.getTime() - 24 * 3_600_000), now)).toBe(50);
    expect(priorityFor("power_cut", undefined, now)).toBe(100);
    expect(priorityFor("power_cut", new Date(now.getTime() + 3_600_000), now)).toBe(100);
  });
});
