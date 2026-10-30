import { describe, expect, it } from "vitest";
import { assessFreshness, endOfIstDay, extractStatedDates, istDateOf, noticeExpiresAt } from "./freshness.ts";

// 30 October 2026, 11:30 IST.
const now = new Date("2026-10-30T06:00:00Z");
const hoursAgo = (h: number): Date => new Date(now.getTime() - h * 3_600_000);
const oct = (day: number) => ({ year: 2026, month: 10, day });

describe("IST helpers", () => {
  it("computes IST calendar days and day ends", () => {
    expect(istDateOf(new Date("2026-10-30T18:29:59Z"))).toEqual(oct(30));
    expect(istDateOf(new Date("2026-10-30T18:30:00Z"))).toEqual(oct(31));
    expect(endOfIstDay(oct(30)).toISOString()).toBe("2026-10-30T18:29:59.999Z");
  });
});

describe("extractStatedDates", () => {
  it("reads numeric, English and Tamil dates", () => {
    expect(extractStatedDates("30.10.2026 அன்று மின்தடை", now)).toEqual([oct(30)]);
    expect(extractStatedDates("on 31/10/26", now)).toEqual([oct(31)]);
    expect(extractStatedDates("30 அக்டோபர் மின்தடை", now)).toEqual([oct(30)]);
    expect(extractStatedDates("அக்டோபர் 31 அன்று", now)).toEqual([oct(31)]);
    expect(extractStatedDates("Shutdown on Oct 31", now)).toEqual([oct(31)]);
    expect(extractStatedDates("on the 31st of October, 2026", now)).toEqual([oct(31)]);
  });

  it("regression: Tamil digits", () => {
    expect(extractStatedDates("௩௧.௧௦.௨௦௨௬ அன்று", now)).toEqual([oct(31)]);
  });

  it("reads relative words and day-only Tamil dates", () => {
    expect(extractStatedDates("நாளை மின்தடை", now)).toEqual([oct(31)]);
    expect(extractStatedDates("Power cut tomorrow", now)).toEqual([oct(31)]);
    expect(extractStatedDates("நாளை மறுநாள் மின்தடை", now)).toEqual([{ year: 2026, month: 11, day: 1 }]);
    expect(extractStatedDates("31-ம் தேதி மின்தடை", now)).toEqual([oct(31)]);
    // The 5th has passed by more than two weeks, so it means next month.
    expect(extractStatedDates("5-ம் தேதி மின்தடை", now)).toEqual([{ year: 2026, month: 11, day: 5 }]);
  });

  it("infers the nearest year when none is given", () => {
    expect(extractStatedDates("Dec 31", new Date("2027-01-02T06:00:00Z"))).toEqual([{ year: 2026, month: 12, day: 31 }]);
  });

  it("does not read time ranges as dates", () => {
    expect(extractStatedDates("காலை 10.30-5.30 மணி வரை", now)).toEqual([]);
    expect(extractStatedDates("5 மேலும் பலர்", now)).toEqual([]);
  });
});

describe("assessFreshness", () => {
  it("regression: a power cut whose day has passed is expired", () => {
    const r = assessFreshness({
      text: "பெருந்துறை பகுதியில் 29.10.2026 அன்று மின்தடை",
      topic: "power_cut",
      publishedAt: hoursAgo(30),
      firstSeenAt: hoursAgo(30),
      now,
      maxAgeHours: 36,
    });
    expect(r.status).toBe("expired");
  });

  it("a notice for a day still ahead stays fresh even when published early", () => {
    const r = assessFreshness({
      text: "31.10.2026 அன்று மின்தடை",
      topic: "power_cut",
      publishedAt: hoursAgo(48),
      firstSeenAt: hoursAgo(48),
      now,
      maxAgeHours: 36,
    });
    expect(r).toEqual({ status: "fresh", expiresAt: endOfIstDay(oct(31)) });
  });

  it("today's notice is fresh until the end of the day IST", () => {
    const input = { text: "இன்று மின்தடை", topic: "power_cut", publishedAt: hoursAgo(2), firstSeenAt: hoursAgo(2), maxAgeHours: 36 } as const;
    expect(assessFreshness({ ...input, now }).status).toBe("fresh");
    expect(assessFreshness({ ...input, now: new Date("2026-10-30T18:30:00Z") }).status).toBe("expired");
  });

  it("other news older than the limit is stale; first sighting counts when there is no publication time", () => {
    expect(
      assessFreshness({ text: "Chennimalai temple festival", topic: "culture", publishedAt: hoursAgo(40), firstSeenAt: hoursAgo(1), now, maxAgeHours: 36 }).status,
    ).toBe("stale");
    expect(assessFreshness({ text: "Chennimalai temple festival", topic: "culture", firstSeenAt: hoursAgo(1), now, maxAgeHours: 36 }).status).toBe("fresh");
  });

  it("dates only expire notice topics", () => {
    expect(noticeExpiresAt("29.10.2026 விழா", "culture", now)).toBeUndefined();
    expect(noticeExpiresAt("மின்தடை அறிவிப்பு", "power_cut", now)).toBeUndefined();
  });
});
