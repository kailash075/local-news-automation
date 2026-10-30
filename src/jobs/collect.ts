import { runCollect } from "../app/collect.ts";
import { SOURCES } from "../config/sources.ts";
import { uuidv7 } from "../lib/ids.ts";
import { syncSources } from "../sheet/stores.ts";
import type { SourceItemStore, SourceStateStore } from "../domain/ports.ts";
import { SourceItemIdSchema } from "../domain/types.ts";
import { appendSummary, setOutput } from "../ops/actions.ts";
import { runJob } from "./context.ts";

await runJob("collect", async ({ env, bridge, stores, clock, count }) => {
  const dryRun = env.DRY_RUN;
  if (!dryRun) await syncSources(bridge, SOURCES, clock);

  // A manual dry run fetches and reports but writes nothing.
  const sourceItems: SourceItemStore = dryRun
    ? {
        ...stores.sourceItems,
        insertIfNew: (item) => Promise.resolve({ inserted: true, item: { ...item, id: SourceItemIdSchema.parse(uuidv7()) } }),
        attachToStory: () => Promise.resolve(),
      }
    : stores.sourceItems;
  const sourceState: SourceStateStore = dryRun
    ? { getFetchState: (sourceId) => Promise.resolve({ sourceId, consecutiveFailures: 0 }), saveFetchState: () => Promise.resolve() }
    : stores.sourceState;

  const report = await runCollect({
    settings: stores.settings,
    sourceState,
    sourceItems,
    clock,
    contactUrl: env.BOT_CONTACT_URL,
    sources: SOURCES,
  });
  if (report.status === "switched_off") {
    appendSummary(`### collect: switched off\nThe Sheet switch \`collecting_enabled\` is off (${report.reason}). Turn it on with Actions -> switch.`);
    setOutput("new_items", 0);
    return "skipped";
  }
  count("new_items", report.newItems);
  appendSummary([`### collect${dryRun ? " (dry run, nothing saved)" : ""}: ${report.newItems} new item(s)`, ...report.lines].join("\n"));
  setOutput("new_items", dryRun ? 0 : report.newItems);
  return "succeeded";
});
