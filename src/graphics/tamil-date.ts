const TAMIL_MONTHS = [
  "ஜனவரி",
  "பிப்ரவரி",
  "மார்ச்",
  "ஏப்ரல்",
  "மே",
  "ஜூன்",
  "ஜூலை",
  "ஆகஸ்ட்",
  "செப்டம்பர்",
  "அக்டோபர்",
  "நவம்பர்",
  "டிசம்பர்",
] as const;

type IstParts = { year: number; month: number; day: number; hour: number; minute: number };

const istParts = (date: Date): IstParts => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
};

/** "30 அக்டோபர் 2026" in IST, the date style in the editorial policy. */
export const formatTamilDate = (date: Date): string => {
  const p = istParts(date);
  const month = TAMIL_MONTHS[p.month - 1];
  if (month === undefined) throw new RangeError("invalid date");
  return `${p.day} ${month} ${p.year}`;
};

/** Minutes since midnight in IST. */
export const istMinuteOfDay = (date: Date): number => {
  const p = istParts(date);
  return p.hour * 60 + p.minute;
};

/** "2026-10-30" in IST. */
export const istDateKey = (date: Date): string => {
  const p = istParts(date);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
};

/**
 * Spoken-style Tamil time for "HH:MM" (24 h): "காலை 9 மணி", "மாலை 5.30 மணி".
 * Periods follow common Tamil news usage.
 */
export const formatTamilTime = (hhmm: string): string => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (match === null) throw new RangeError(`invalid time: ${hhmm}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const period = hour < 4 ? "இரவு" : hour < 12 ? "காலை" : hour < 16 ? "மதியம்" : hour < 19 ? "மாலை" : "இரவு";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const time = minute === 0 ? `${h12}` : `${h12}.${String(minute).padStart(2, "0")}`;
  return `${period} ${time} மணி`;
};
