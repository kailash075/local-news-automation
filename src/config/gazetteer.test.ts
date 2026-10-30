import { describe, expect, it } from "vitest";
import { ERODE_PLACES, NEIGHBOUR_PLACES } from "./gazetteer.ts";

const allTamil = (places: readonly { ta: readonly string[]; weakTa?: readonly string[] }[]): string[] =>
  places.flatMap((p) => [...p.ta, ...(p.weakTa ?? [])]);

describe("gazetteer", () => {
  it("keys are unique", () => {
    const keys = [...ERODE_PLACES, ...NEIGHBOUR_PLACES].map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("Tamil names are stored in NFC", () => {
    for (const name of [...allTamil(ERODE_PLACES), ...allTamil(NEIGHBOUR_PLACES)]) {
      expect(name).toBe(name.normalize("NFC"));
    }
  });

  it("no Erode stem starts a neighbour name and no neighbour stem starts an Erode name", () => {
    const erode = allTamil(ERODE_PLACES);
    const neighbours = allTamil(NEIGHBOUR_PLACES);
    for (const e of erode) for (const n of neighbours) {
      expect(n.startsWith(e), `${e} / ${n}`).toBe(false);
      expect(e.startsWith(n), `${n} / ${e}`).toBe(false);
    }
  });
});
