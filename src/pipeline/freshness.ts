import type { Topic } from "../domain/types.ts";
import { normaliseForStorage, stripZeroWidth, tamilDigitsToAscii } from "./normalise.ts";

/**
 * Freshness rules (Coimbatore 360 lessons: never post a power cut that has already happened, or yesterday's news as new).
 * All calendar logic is in IST (Asia/Kolkata, UTC+05:30, no daylight saving). Pure: `now` is always a parameter.
 */

const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
const DAY_MS = 86_400_000;
const MAX_DATE_DISTANCE_DAYS = 200;

export type IstDate = { year: number; month: number; day: number };

export const istDateOf = (date: Date): IstDate => {
  const shifted = new Date(date.getTime() + IST_OFFSET_MS);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
};

/** 23:59:59.999 IST on the given day, as an instant. */
export const endOfIstDay = (d: IstDate): Date => new Date(Date.UTC(d.year, d.month - 1, d.day, 23, 59, 59, 999) - IST_OFFSET_MS);

const startOfIstDay = (d: IstDate): Date => new Date(Date.UTC(d.year, d.month - 1, d.day) - IST_OFFSET_MS);

const addDays = (d: IstDate, days: number): IstDate => istDateOf(new Date(startOfIstDay(d).getTime() + days * DAY_MS + 1));

const isValidDate = (year: number, month: number, day: number): boolean => {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
};

/** Year closest to the reference date when the text gives none. */
const inferYear = (month: number, day: number, reference: IstDate): number | undefined => {
  const ref = Date.UTC(reference.year, reference.month - 1, reference.day);
  let best: { year: number; distance: number } | undefined;
  for (const year of [reference.year - 1, reference.year, reference.year + 1]) {
    if (!isValidDate(year, month, day)) continue;
    const distance = Math.abs(Date.UTC(year, month - 1, day) - ref);
    if (best === undefined || distance < best.distance) best = { year, distance };
  }
  return best?.year;
};

const EN_MONTHS: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const TA_MONTHS: Readonly<Record<string, number>> = {
  "ஜனவரி": 1, "பிப்ரவரி": 2, "மார்ச்": 3, "ஏப்ரல்": 4, "மே": 5, "ஜூன்": 6, "ஜூலை": 7, "ஆகஸ்ட்": 8, "ஆகஸ்டு": 8,
  "செப்டம்பர்": 9, "அக்டோபர்": 10, "நவம்பர்": 11, "டிசம்பர்": 12,
};

const enMonth = (name: string): number | undefined => EN_MONTHS[name.toLowerCase().slice(0, name.toLowerCase().startsWith("sept") ? 4 : 3)];

const EN_MONTH_RE = "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const TA_MONTH_RE = `(${Object.keys(TA_MONTHS).join("|")})`;
const NOT_TAMIL_AFTER = "(?![\\u0B80-\\u0BFF])";

const NUMERIC = /(?<!\d)(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})(?!\d)/g;
const EN_DAY_MONTH = new RegExp(`(?<![A-Za-z0-9])(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${EN_MONTH_RE}\\.?(?:,?\\s+(\\d{4}))?(?![A-Za-z])`, "gi");
const EN_MONTH_DAY = new RegExp(`(?<![A-Za-z])${EN_MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?(?!\\d)`, "gi");
const TA_DAY_MONTH = new RegExp(`(?<!\\d)(\\d{1,2})\\s*(?:-?\\s*(?:ம்|ஆம்)\\s*(?:தேதி)?)?\\s*${TA_MONTH_RE}${NOT_TAMIL_AFTER}(?:\\s*,?\\s*(\\d{4}))?`, "gu");
const TA_MONTH_DAY = new RegExp(`${TA_MONTH_RE}\\s+(\\d{1,2})(?!\\d)(?:\\s*,?\\s*(\\d{4}))?`, "gu");
const TA_DAY_ONLY = /(?<!\d)(\d{1,2})\s*-?\s*(?:ம்|ஆம்)\s*தேதி/gu;

const toDate = (day: number, month: number | undefined, yearText: string | undefined, reference: IstDate): IstDate | undefined => {
  if (month === undefined) return undefined;
  let year: number | undefined;
  if (yearText === undefined || yearText === "") year = inferYear(month, day, reference);
  else year = yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText);
  if (year === undefined || !isValidDate(year, month, day)) return undefined;
  // A "date" far from the reference is almost always a misread time range such as "10.30-5.30" (read as 30.5.2030).
  const distance = Math.abs(Date.UTC(year, month - 1, day) - Date.UTC(reference.year, reference.month - 1, reference.day));
  if (distance > MAX_DATE_DISTANCE_DAYS * DAY_MS) return undefined;
  return { year, month, day };
};

/**
 * Calendar dates stated in the text, in IST. Understands "30.10.2026", "30/10/26", "30 October", "Oct 30, 2026",
 * "30 அக்டோபர்", "அக்டோபர் 30", "30-ம் தேதி" (month inferred), and the relative words இன்று/today, நாளை/tomorrow
 * (relative to `reference`, normally the publication time).
 */
export const extractStatedDates = (text: string, reference: Date): readonly IstDate[] => {
  const t = tamilDigitsToAscii(stripZeroWidth(normaliseForStorage(text)));
  const ref = istDateOf(reference);
  const found: IstDate[] = [];
  const push = (d: IstDate | undefined): void => {
    if (d !== undefined) found.push(d);
  };

  for (const m of t.matchAll(NUMERIC)) push(toDate(Number(m[1]), Number(m[2]), m[3], ref));
  for (const m of t.matchAll(EN_DAY_MONTH)) push(toDate(Number(m[1]), enMonth(m[2] ?? ""), m[3], ref));
  for (const m of t.matchAll(EN_MONTH_DAY)) push(toDate(Number(m[2]), enMonth(m[1] ?? ""), m[3], ref));
  for (const m of t.matchAll(TA_DAY_MONTH)) push(toDate(Number(m[1]), TA_MONTHS[m[2] ?? ""], m[3], ref));
  for (const m of t.matchAll(TA_MONTH_DAY)) push(toDate(Number(m[2]), TA_MONTHS[m[1] ?? ""], m[3], ref));
  for (const m of t.matchAll(TA_DAY_ONLY)) {
    // "30-ம் தேதி" without a month: this month, or next month when that day is already well past.
    const day = Number(m[1]);
    let candidate = toDate(day, ref.month, String(ref.year), ref);
    if (candidate === undefined || startOfIstDay(candidate).getTime() < startOfIstDay(ref).getTime() - 15 * DAY_MS) {
      const next = addDays({ year: ref.year, month: ref.month, day: 1 }, 32);
      candidate = toDate(day, next.month, String(next.year), ref);
    }
    push(candidate);
  }

  if (/நாளை\s*மறுநாள்|day after tomorrow/iu.test(t)) push(addDays(ref, 2));
  if (/நாளை|(?<![A-Za-z])tomorrow(?![A-Za-z])/iu.test(t.replace(/நாளை\s*மறுநாள்|day after tomorrow/giu, ""))) push(addDays(ref, 1));
  if (/இன்று|(?<![A-Za-z])today(?![A-Za-z])/iu.test(t)) push(ref);
  return found;
};

/** Topics whose items are time-bound notices: once the stated day has passed, they must not be published. */
export const NOTICE_TOPICS: readonly Topic[] = ["power_cut", "water_supply", "traffic", "weather", "jobs"];

/** End of the latest stated day (IST) for a notice, or undefined when the topic is not a notice or no date is stated. */
export const noticeExpiresAt = (text: string, topic: Topic, reference: Date): Date | undefined => {
  if (!NOTICE_TOPICS.includes(topic)) return undefined;
  const dates = extractStatedDates(text, reference);
  let latest: Date | undefined;
  for (const d of dates) {
    const end = endOfIstDay(d);
    if (latest === undefined || end.getTime() > latest.getTime()) latest = end;
  }
  return latest;
};

export type FreshnessInput = {
  text: string;
  topic: Topic;
  publishedAt?: Date;
  firstSeenAt: Date;
  now: Date;
  maxAgeHours: number;
};

export type Freshness =
  | { status: "fresh"; expiresAt?: Date }
  | { status: "stale"; reason: string }
  | { status: "expired"; reason: string; expiresAt: Date };

/**
 * A notice whose stated day has passed is expired. A notice for a day still ahead stays fresh even when it was
 * published early. Anything else older than `maxAgeHours` (by publication time, or first sighting when the source
 * gives no date) is stale.
 */
export const assessFreshness = (input: FreshnessInput): Freshness => {
  const reference = input.publishedAt ?? input.firstSeenAt;
  const expiresAt = noticeExpiresAt(input.text, input.topic, reference);
  if (expiresAt !== undefined) {
    if (input.now.getTime() > expiresAt.getTime()) {
      const d = istDateOf(expiresAt);
      return { status: "expired", reason: `notice date ${d.day}.${d.month}.${d.year} (IST) has passed`, expiresAt };
    }
    return { status: "fresh", expiresAt };
  }
  const ageHours = (input.now.getTime() - reference.getTime()) / 3_600_000;
  if (ageHours > input.maxAgeHours) {
    return { status: "stale", reason: `${Math.floor(ageHours)} h old (limit ${input.maxAgeHours} h)` };
  }
  return { status: "fresh" };
};
