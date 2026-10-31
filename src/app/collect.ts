import { collectSource, type CollectOutcome, type RobotsCache } from "../collectors/collect.ts";
import { scheduledRunPaused } from "./collect-switch.ts";
import type { FetchLike } from "../collectors/http.ts";
import { isCollectable } from "../config/sources.ts";
import type { Clock, SettingsStore, SourceItemStore, SourceStateStore } from "../domain/ports.ts";
import type { Source } from "../domain/types.ts";

export type CollectRunDeps = {
  settings: SettingsStore;
  /** A scheduled run collects only while automatic collecting is started (Actions -> collect-switch). */
  scheduled: boolean;
  sourceState: SourceStateStore;
  sourceItems: SourceItemStore;
  clock: Clock;
  contactUrl: string;
  sources: readonly Source[];
  fetch?: FetchLike;
};

export type CollectRunReport =
  | { status: "switched_off"; reason: string }
  | { status: "done"; newItems: number; lines: readonly string[]; outcomes: readonly CollectOutcome[] };

/**
 * One collection round over the registry. A source is fetched only when its terms review is approved and current,
 * it is enabled, and robots.txt allows the path (checked inside collectSource).
 */
export const runCollect = async (deps: CollectRunDeps): Promise<CollectRunReport> => {
  const paused = await scheduledRunPaused(deps.settings, deps.scheduled);
  if (paused !== undefined) return { status: "switched_off", reason: paused };

  const robotsCache: RobotsCache = new Map();
  const lines: string[] = [];
  const outcomes: CollectOutcome[] = [];
  let newItems = 0;
  for (const source of deps.sources) {
    const gate = isCollectable(source, deps.clock.now());
    if (!gate.ok) {
      lines.push(`- ${source.name}: not collected (${gate.error.code})`);
      continue;
    }
    const outcome = await collectSource(source, {
      clock: deps.clock,
      sourceState: deps.sourceState,
      sourceItems: deps.sourceItems,
      contactUrl: deps.contactUrl,
      robotsCache,
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    });
    outcomes.push(outcome);
    switch (outcome.status) {
      case "fetched":
        newItems += outcome.inserted.length;
        lines.push(
          `- ${source.name}: ${outcome.seen} seen, ${outcome.inserted.length} new, ${outcome.invalid} unusable` +
            (outcome.undated === 0 ? "" : `, ${outcome.undated} new without a readable date (skipped)`),
        );
        break;
      case "not_modified":
        lines.push(`- ${source.name}: not modified`);
        break;
      case "skipped":
        lines.push(`- ${source.name}: skipped (${outcome.reason})`);
        break;
      case "failed":
        lines.push(
          `- ${source.name}: FAILED (${outcome.error}), ${outcome.consecutiveFailures} in a row${outcome.shouldDisable ? " - disable this source and review it" : ""}`,
        );
        break;
    }
  }
  return { status: "done", newItems, lines, outcomes };
};
