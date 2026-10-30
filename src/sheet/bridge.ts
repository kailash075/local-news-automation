import { setTimeout as sleepMs } from "node:timers/promises";
import { z } from "zod";
import type { FetchLike } from "../collectors/http.ts";

/**
 * Client for the Apps Script bridge in apps-script/Code.gs: the only way the jobs reach the Google Sheet.
 * The key travels in the POST body as `auth` (Apps Script cannot read request headers), never in the URL.
 */

export type Row = Readonly<Record<string, string>>;

/** String comparison: timestamps are written as `Date.toISOString()`, so they compare correctly as text. */
export type Comparison = {
  gt?: string;
  gte?: string;
  lt?: string;
  lte?: string;
  notIn?: readonly string[];
  /** An empty cell matches too. Without it, an object condition never matches an empty cell. */
  orEmpty?: boolean;
};

/** A string means equal, null means empty, an array means one of. */
export type Condition = string | null | readonly string[] | Comparison;

export type Where = Readonly<Record<string, Condition>>;

export type TableDef = { name: string; columns: readonly string[]; appendOnly: boolean };

export type InsertResult = { inserted: true } | { inserted: false; existing: Row };

export type SelectOp = { op: "select"; table: string; where?: Where; columns?: readonly string[] };
export type InsertOp = {
  op: "insert";
  table: string;
  rows: readonly Row[];
  unique?: readonly string[];
  /** Refuse the insert (error "conflict: <name>") when any row matches; only with a single row. */
  refuseIf?: { name: string; where: Where };
};
/** Updates the columns given in `row` of the row whose `match` columns are equal, or appends `row`. */
export type UpsertOp = { op: "upsert"; table: string; match: readonly string[]; row: Row };
export type UpdateOp = { op: "update"; table: string; where: Where; set: Row; orderBy?: readonly string[]; limit?: number };
export type DataOp = SelectOp | InsertOp | UpsertOp | UpdateOp;

type ResultOf<T extends DataOp> = T extends SelectOp
  ? readonly Row[]
  : T extends InsertOp
    ? readonly InsertResult[]
    : T extends UpsertOp
      ? { inserted: boolean }
      : readonly Row[];

export class BridgeError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "BridgeError";
    this.retryable = retryable;
  }
}

export type BridgeClient = {
  ping: () => Promise<{ schemaVersion: string | null; time: string }>;
  setup: (schemaVersion: string, tables: readonly TableDef[]) => Promise<{ created: readonly string[]; extended: readonly string[] }>;
  selfTest: (values: readonly string[]) => Promise<readonly string[]>;
  select: (table: string, where?: Where, columns?: readonly string[]) => Promise<readonly Row[]>;
  insert: (table: string, rows: readonly Row[], options?: Pick<InsertOp, "unique" | "refuseIf">) => Promise<readonly InsertResult[]>;
  upsert: (table: string, match: readonly string[], row: Row) => Promise<{ inserted: boolean }>;
  update: (table: string, where: Where, set: Row, options?: Pick<UpdateOp, "orderBy" | "limit">) => Promise<readonly Row[]>;
  secretGet: (name: string) => Promise<string | undefined>;
  secretPut: (name: string, value: string) => Promise<void>;
  /** Runs the operations in order under one lock, in one request. Not a transaction: an error stops the batch midway. */
  batch: <const T extends readonly DataOp[]>(ops: T) => Promise<{ -readonly [K in keyof T]: ResultOf<T[K]> }>;
};

const RowSchema = z.record(z.string(), z.string());
const RowsSchema = z.array(RowSchema).readonly();
const InsertResultsSchema = z
  .array(z.union([z.strictObject({ inserted: z.literal(true) }), z.strictObject({ inserted: z.literal(false), existing: RowSchema })]))
  .readonly();
const UpsertSchema = z.object({ inserted: z.boolean() });

const resultSchemaFor = (op: DataOp["op"]): z.ZodType => {
  switch (op) {
    case "select":
    case "update":
      return z.object({ rows: RowsSchema }).transform((r) => r.rows);
    case "insert":
      return z.object({ results: InsertResultsSchema }).transform((r) => r.results);
    case "upsert":
      return UpsertSchema.transform((r) => ({ inserted: r.inserted }));
  }
};

const EnvelopeSchema = z.union([
  z.looseObject({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string(), retryable: z.boolean().default(false) }),
]);

export type BridgeOptions = {
  url: string;
  key: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Waits before the 2nd and 3rd attempt. A lost response is safe to retry: inserts are unique on id. */
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
};

export const createBridgeClient = (options: BridgeOptions): BridgeClient => {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 90_000;
  const delays = options.retryDelaysMs ?? [2_000, 8_000];
  const sleep = options.sleep ?? ((ms: number) => sleepMs(ms));

  const once = async (payload: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> => {
    let res: Response;
    try {
      res = await fetchImpl(options.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, auth: options.key }),
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new BridgeError(`bridge request failed: ${error instanceof Error ? error.name : "unknown"}`, true);
    }
    const text = await res.text();
    if (res.status === 429 || res.status >= 500) throw new BridgeError(`bridge answered HTTP ${res.status}`, true);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new BridgeError(
        `bridge did not answer with JSON (HTTP ${res.status}); check the web app URL and that it is deployed with access "Anyone"`,
        false,
      );
    }
    const envelope = EnvelopeSchema.safeParse(body);
    if (!envelope.success) throw new BridgeError("bridge answered with an unexpected shape", false);
    if (!envelope.data.ok) throw new BridgeError(`bridge refused ${String(payload["op"])}: ${envelope.data.error}`, envelope.data.retryable);
    return envelope.data;
  };

  const call = async (payload: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await once(payload);
      } catch (error) {
        const delay = delays[attempt];
        if (!(error instanceof BridgeError) || !error.retryable || delay === undefined) throw error;
        await sleep(delay);
      }
    }
  };

  const data = async <T extends DataOp>(op: T): Promise<ResultOf<T>> =>
    resultSchemaFor(op.op).parse(await call(op)) as ResultOf<T>;

  return {
    ping: async () => z.object({ schemaVersion: z.string().nullable(), time: z.string() }).parse(await call({ op: "ping" })),
    setup: async (schemaVersion, tables) =>
      z.object({ created: z.array(z.string()).readonly(), extended: z.array(z.string()).readonly() }).parse(await call({ op: "setup", schemaVersion, tables })),
    selfTest: async (values) => z.object({ values: z.array(z.string()).readonly() }).parse(await call({ op: "selfTest", values })).values,
    select: (table, where, columns) =>
      data({ op: "select", table, ...(where === undefined ? {} : { where }), ...(columns === undefined ? {} : { columns }) }),
    insert: (table, rows, opts = {}) => data({ op: "insert", table, rows, ...opts }),
    upsert: (table, match, row) => data({ op: "upsert", table, match, row }),
    update: (table, where, set, opts = {}) => data({ op: "update", table, where, set, ...opts }),
    secretGet: async (name) => {
      const value = z.object({ value: z.string().nullable() }).parse(await call({ op: "secretGet", name })).value;
      return value ?? undefined;
    },
    secretPut: async (name, value) => {
      await call({ op: "secretPut", name, value });
    },
    batch: async (ops) => {
      const { results } = z.object({ results: z.array(z.unknown()) }).parse(await call({ op: "batch", ops }));
      if (results.length !== ops.length) throw new BridgeError("bridge batch answered with the wrong number of results", false);
      return ops.map((op, i) => resultSchemaFor(op.op).parse(results[i])) as never;
    },
  };
};
