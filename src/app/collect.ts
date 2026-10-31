import { collectSource, type CollectDeps, type CollectOutcome, type RobotsCache } from "../collectors/collect.ts";
import { scheduledRunPaused } from "./collect-switch.ts";
import type { FetchLike } from "../collectors/http.ts";
import { isCollectable } from "../config/sources.ts";
import type { Clock, SettingsStore, SourceStateStore } from "../domain/ports.ts";
import { SourceItemIdSchema, type Source } from "../domain/types.ts";
import { uuidv7 } from "../lib/ids.ts";

export type CollectRunDeps = {
  settings: SettingsStore;
  /** A scheduled run collects only while automatic collecting is started (Actions -> collect-switch). */
  scheduled: boolean;
  sourceState: SourceStateStore;
  sourceItems: CollectDeps["sourceItems"];
  clock: Clock;
  contactUrl: string;
  sources: readonly Source[];
  fetch?: FetchLike;
};

export type CollectRunReport =
  | { status: "switched_off"; reason: string }
  | { status: "done"; newItems: number; lines: readonly string[]; outcomes: readonly CollectOutcome[] };

/**
 * Stores for a manual dry run: it reads what is already stored, so the report counts only really new items, and it
 * writes nothing. Every source counts as never fetched, so each page is fetched in full.
 */
export const dryRunCollectStores = (real: Pick<CollectRunDeps, "sourceItems">): Pick<CollectRunDeps, "sourceItems" | "sourceState"> => ({
  sourceItems: {
    isKnown: real.sourceItems.isKnown,
    insertManyIfNew: async (items) => {
      const fresh = [];
      for (const item of items) {
        if (!(await real.sourceItems.isKnown(item.sourceId, item.urlHash))) fresh.push({ ...item, id: SourceItemIdSchema.parse(uuidv7()) });
      }
      return fresh;
    },
  },
  sourceState: {
    getFetchState: (sourceId) => Promise.resolve({ sourceId, consecutiveFailures: 0 }),
    saveFetchState: () => Promise.resolve(),
  },
});

const reportLine = (source: Source, outcome: CollectOutcome): string => {
  switch (outcome.status) {
    case "fetched":
      return (
        `- ${source.name}: ${outcome.seen} seen, ${outcome.inserted.length} new, ${outcome.invalid} unusable` +
        (outcome.undated === 0 ? "" : `, ${outcome.undated} new without a readable date (skipped)`)
      );
    case "not_modified":
      return `- ${source.name}: not modified`;
    case "skipped":
      return `- ${source.name}: skipped (${outcome.reason})`;
    case "failed":
      return `- ${source.name}: FAILED (${outcome.error}), ${outcome.consecutiveFailures} in a row${outcome.shouldDisable ? " - disable this source and review it" : ""}`;
  }
};

/**
 * One collection round over the registry. A source is fetched only when its terms review is approved and current,
 * it is enabled, and robots.txt allows the path (checked inside collectSource).
 * Different sites are collected at the same time, which keeps the Actions run short. Sources on the same site still
 * run one after another, so a site never gets more than one request at a time from us.
 */
export const runCollect = async (deps: CollectRunDeps): Promise<CollectRunReport> => {
  const paused = await scheduledRunPaused(deps.settings, deps.scheduled);
  if (paused !== undefined) return { status: "switched_off", reason: paused };

  const now = deps.clock.now();
  const gates = deps.sources.map((source) => ({ source, gate: isCollectable(source, now) }));
  const bySite = new Map<string, Source[]>();
  for (const { source, gate } of gates) {
    if (!gate.ok) continue;
    const site = new URL(source.url).origin;
    bySite.set(site, [...(bySite.get(site) ?? []), source]);
  }
  const robotsCache: RobotsCache = new Map();
  const done = new Map<Source, CollectOutcome>();
  const settled = await Promise.allSettled(
    [...bySite.values()].map(async (sources) => {
      for (const source of sources) {
        const outcome = await collectSource(source, {
          clock: deps.clock,
          sourceState: deps.sourceState,
          sourceItems: deps.sourceItems,
          contactUrl: deps.contactUrl,
          robotsCache,
          ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
        });
        done.set(source, outcome);
      }
    }),
  );
  // Every site finishes its own work first; then a Sheet failure fails the run.
  for (const result of settled) {
    if (result.status === "fulfilled") continue;
    const reason: unknown = result.reason;
    throw reason instanceof Error ? reason : new Error("collect failed", { cause: reason });
  }

  const lines: string[] = [];
  const outcomes: CollectOutcome[] = [];
  let newItems = 0;
  for (const { source, gate } of gates) {
    const outcome = done.get(source);
    if (!gate.ok || outcome === undefined) {
      lines.push(`- ${source.name}: not collected (${gate.ok ? "no result" : gate.error.code})`);
      continue;
    }
    outcomes.push(outcome);
    if (outcome.status === "fetched") newItems += outcome.inserted.length;
    lines.push(reportLine(source, outcome));
  }
  return { status: "done", newItems, lines, outcomes };
};
