import type { Clock } from "../../src/domain/ports.ts";

export type TestClock = Clock & {
  set: (at: Date) => void;
  advance: (ms: number) => void;
};

/** A clock tests control. Starts at 2026-10-30 10:00 IST unless told otherwise. */
export const testClock = (start: Date = new Date("2026-10-30T04:30:00.000Z")): TestClock => {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    set: (at) => {
      current = new Date(at);
    },
    advance: (ms) => {
      current = new Date(current.getTime() + ms);
    },
  };
};
