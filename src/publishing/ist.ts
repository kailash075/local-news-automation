import { IsoDateTimeSchema, type IsoDateTime } from "../domain/types.ts";

/** India Standard Time is UTC+05:30 all year (no daylight saving). */
export const IST_OFFSET_MINUTES = 5 * 60 + 30;
const MINUTE_MS = 60_000;
const DAY_MINUTES = 24 * 60;

export const toIso = (date: Date): IsoDateTime => IsoDateTimeSchema.parse(date.toISOString());

/** Minutes since midnight IST, 0 to 1439. */
export const istMinuteOfDay = (date: Date): number => {
  const minutes = Math.floor(date.getTime() / MINUTE_MS) + IST_OFFSET_MINUTES;
  return ((minutes % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
};

/** The instant of the most recent midnight IST at or before `date`. */
export const startOfIstDay = (date: Date): Date =>
  new Date(date.getTime() - istMinuteOfDay(date) * MINUTE_MS - (date.getTime() % MINUTE_MS));

export type PostingWindow = { startMinute: number; endMinute: number };

export const insideWindow = (date: Date, window: PostingWindow): boolean => {
  const m = istMinuteOfDay(date);
  return m >= window.startMinute && m < window.endMinute;
};

/** The next instant at or after `now` whose IST clock reads hour:minute. */
export const nextIstTime = (now: Date, hour: number, minute: number): Date => {
  const target = new Date(startOfIstDay(now).getTime() + (hour * 60 + minute) * MINUTE_MS);
  return target.getTime() >= now.getTime() ? target : new Date(target.getTime() + DAY_MINUTES * MINUTE_MS);
};

export const formatIst = (date: Date): string => {
  const m = istMinuteOfDay(date);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)} IST`;
};
