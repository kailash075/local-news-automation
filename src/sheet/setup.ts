import type { BridgeClient } from "./bridge.ts";
import { SHEET_SCHEMA_VERSION, TABLE_LIST } from "./tables.ts";

/**
 * Values Sheets is known to change when they are typed into a cell: formulas, numbers with leading zeros, dates,
 * booleans, leading apostrophes. The migrate workflow writes them through the real bridge and reads them back,
 * so a Google-side change in behaviour shows up there instead of as corrupted rows.
 */
export const SELF_TEST_VALUES: readonly string[] = [
  "=IMPORTXML(\"https://example.com\",\"//a\")",
  "+91 94430 00000",
  "-5",
  "@erodeglitz",
  "'quoted'",
  "007",
  "1e5",
  "TRUE",
  "2026-10-30",
  "2026-10-30T04:30:00.000Z",
  "0.10",
  "ஈரோடு மின்தடை: காலை 9 மணி",
  "line one\nline two",
  "#ஈரோடு #Erode",
  '{"a":[1,2]}',
  " leading space",
  "trailing space ",
];

export type SetupReport = {
  schemaVersion: string;
  created: readonly string[];
  extended: readonly string[];
  selfTestFailures: readonly { sent: string; received: string }[];
};

/** Creates missing tabs and columns (never removes any), records the layout version, then round-trips SELF_TEST_VALUES. */
export const setupSheet = async (bridge: BridgeClient): Promise<SetupReport> => {
  const { created, extended } = await bridge.setup(SHEET_SCHEMA_VERSION, TABLE_LIST);
  const back = await bridge.selfTest(SELF_TEST_VALUES);
  const selfTestFailures = SELF_TEST_VALUES.flatMap((sent, i) => (back[i] === sent ? [] : [{ sent, received: back[i] ?? "(missing)" }]));
  return { schemaVersion: SHEET_SCHEMA_VERSION, created, extended, selfTestFailures };
};

/** Jobs refuse to run against a Sheet whose layout is older or newer than the code. */
export const assertSheetSchema = async (bridge: BridgeClient): Promise<void> => {
  const { schemaVersion } = await bridge.ping();
  if (schemaVersion !== SHEET_SCHEMA_VERSION) {
    throw new Error(
      `the Sheet layout is ${schemaVersion ?? "not set up"} but this code expects ${SHEET_SCHEMA_VERSION}; run the migrate workflow`,
    );
  }
};
