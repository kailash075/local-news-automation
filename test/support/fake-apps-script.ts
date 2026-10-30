import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import type { FetchLike } from "../../src/collectors/http.ts";

/**
 * Runs the real apps-script/Code.gs inside a Node `vm`, with small fakes of the Google services it uses.
 * The fake Sheet copies the Sheets behaviours the bridge must survive: text that starts with "=" becomes a formula,
 * a leading apostrophe forces text and is hidden, numbers / booleans / dates are converted unless the cell is
 * formatted as plain text ("@"), and ranges outside the sheet's size throw.
 */

type CellValue = string | number | boolean | Date;
type Cell = { value: CellValue; formula: boolean; format: string };

const OUTSIDE = "The coordinates of the range are outside the dimensions of the sheet.";

const parseEntered = (raw: unknown, format: string): Omit<Cell, "format"> => {
  if (typeof raw !== "string") return { value: raw as CellValue, formula: false };
  if (raw.startsWith("'")) return { value: raw.slice(1), formula: false };
  if (raw.startsWith("=")) return { value: raw, formula: true };
  if (format === "@") return { value: raw, formula: false };
  if (/^[+-]?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(raw)) return { value: Number(raw), formula: false };
  if (raw === "TRUE" || raw === "FALSE") return { value: raw === "TRUE", formula: false };
  if (/^\d{4}-\d{2}-\d{2}/.test(raw) && !Number.isNaN(Date.parse(raw))) return { value: new Date(raw), formula: false };
  return { value: raw, formula: false };
};

export class FakeSheet {
  readonly cells = new Map<string, Cell>();
  maxRows = 1000;
  maxColumns = 26;
  frozenRows = 0;
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }

  getName(): string {
    return this.name;
  }
  getMaxRows(): number {
    return this.maxRows;
  }
  getMaxColumns(): number {
    return this.maxColumns;
  }
  getLastRow(): number {
    let last = 0;
    for (const [k, c] of this.cells) if (c.value !== "") last = Math.max(last, Number(k.split(",")[0]));
    return last;
  }
  getLastColumn(): number {
    let last = 0;
    for (const [k, c] of this.cells) if (c.value !== "") last = Math.max(last, Number(k.split(",")[1]));
    return last;
  }
  insertRowsAfter(_after: number, n: number): void {
    this.maxRows += n;
  }
  insertColumnsAfter(_after: number, n: number): void {
    this.maxColumns += n;
  }
  setFrozenRows(n: number): void {
    this.frozenRows = n;
  }
  getRange(row: number, column: number, numRows = 1, numColumns = 1): FakeRange {
    if (row < 1 || column < 1 || row + numRows - 1 > this.maxRows || column + numColumns - 1 > this.maxColumns) throw new Error(OUTSIDE);
    return new FakeRange(this, row, column, numRows, numColumns);
  }
  /** What a person sees in the Sheet: the stored value, "#ERROR!" for a formula. */
  read(row: number, column: number): CellValue {
    const c = this.cells.get(`${row},${column}`);
    if (c === undefined) return "";
    return c.formula ? "#ERROR!" : c.value;
  }
  /** Simulates the owner typing into a cell. */
  type(row: number, column: number, raw: string): void {
    const key = `${row},${column}`;
    const format = this.cells.get(key)?.format ?? "";
    this.cells.set(key, { ...parseEntered(raw, format), format });
  }
}

export class FakeRange {
  readonly sheet: FakeSheet;
  readonly row: number;
  readonly column: number;
  readonly numRows: number;
  readonly numColumns: number;
  constructor(sheet: FakeSheet, row: number, column: number, numRows: number, numColumns: number) {
    this.sheet = sheet;
    this.row = row;
    this.column = column;
    this.numRows = numRows;
    this.numColumns = numColumns;
  }

  private each(fn: (r: number, c: number, i: number, j: number) => void): void {
    for (let i = 0; i < this.numRows; i += 1) for (let j = 0; j < this.numColumns; j += 1) fn(this.row + i, this.column + j, i, j);
  }
  getValues(): CellValue[][] {
    const out: CellValue[][] = Array.from({ length: this.numRows }, () => []);
    this.each((r, c, i) => out[i]?.push(this.sheet.read(r, c)));
    return out;
  }
  setValues(values: unknown[][]): this {
    if (values.length !== this.numRows || values.some((v) => v.length !== this.numColumns)) {
      throw new Error("The number of rows or columns in the data does not match the range.");
    }
    this.each((r, c, i, j) => {
      const key = `${r},${c}`;
      const format = this.sheet.cells.get(key)?.format ?? "";
      this.sheet.cells.set(key, { ...parseEntered(values[i]?.[j], format), format });
    });
    return this;
  }
  setNumberFormat(format: string): this {
    this.each((r, c) => {
      const key = `${r},${c}`;
      const cell = this.sheet.cells.get(key);
      this.sheet.cells.set(key, cell === undefined ? { value: "", formula: false, format } : { ...cell, format });
    });
    return this;
  }
  setFontWeight(): this {
    return this;
  }
}

export class FakeSpreadsheet {
  readonly sheets = new Map<string, FakeSheet>();
  getSheetByName(name: string): FakeSheet | null {
    return this.sheets.get(name) ?? null;
  }
  insertSheet(name: string): FakeSheet {
    if (this.sheets.has(name)) throw new Error(`A sheet with the name "${name}" already exists.`);
    const sheet = new FakeSheet(name);
    this.sheets.set(name, sheet);
    return sheet;
  }
  deleteSheet(sheet: FakeSheet): void {
    this.sheets.delete(sheet.name);
  }
}

export type FakeAppsScript = {
  fetch: FetchLike;
  spreadsheet: FakeSpreadsheet;
  properties: Map<string, string>;
  /** While true, the script lock cannot be taken (another request holds it). */
  lockHeld: { value: boolean };
  /** Every request body the bridge received. */
  requests: unknown[];
  /** Runs a top-level function of Code.gs, as the owner would from the Apps Script editor. */
  runFunction: (name: string) => unknown;
};

const CODE = readFileSync(new URL("../../apps-script/Code.gs", import.meta.url), "utf8");

export const BRIDGE_TEST_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

export const createFakeAppsScript = (options: { bridgeKey?: string | null } = {}): FakeAppsScript => {
  const spreadsheet = new FakeSpreadsheet();
  const properties = new Map<string, string>();
  const key = options.bridgeKey === undefined ? BRIDGE_TEST_KEY : options.bridgeKey;
  if (key !== null) properties.set("BRIDGE_KEY", key);
  const lockHeld = { value: false };
  const requests: unknown[] = [];

  const context = vm.createContext({
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, flush: () => undefined },
    LockService: { getScriptLock: () => ({ tryLock: () => !lockHeld.value, releaseLock: () => undefined }) },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k: string) => properties.get(k) ?? null,
        setProperty: (k: string, v: string) => properties.set(k, v),
      }),
    },
    ContentService: {
      MimeType: { JSON: "application/json" },
      createTextOutput: (text: string) => ({ setMimeType: function (this: unknown) { return this; }, getContent: () => text }),
    },
    Utilities: { getUuid: () => randomUUID() },
    Logger: { log: () => undefined },
  });
  vm.runInContext(CODE, context, { filename: "Code.gs" });
  const doPost = context["doPost"] as (e: { postData: { contents: string } }) => { getContent: () => string };

  const fetchImpl: FetchLike = (_url, init) => {
    const contents = typeof init?.body === "string" ? init.body : "";
    requests.push(JSON.parse(contents) as unknown);
    const out = doPost({ postData: { contents } });
    return Promise.resolve(new Response(out.getContent(), { status: 200, headers: { "content-type": "application/json" } }));
  };

  const runFunction = (name: string): unknown => (context[name] as () => unknown)();

  return { fetch: fetchImpl, spreadsheet, properties, lockHeld, requests, runFunction };
};
