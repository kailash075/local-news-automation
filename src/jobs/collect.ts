import { dryRunCollectStores, runCollect } from "../app/collect.ts";
import { SOURCES } from "../config/sources.ts";
import { syncSources } from "../sheet/stores.ts";
import { appendSummary, setOutput } from "../ops/actions.ts";
import { runJob } from "./context.ts";

await runJob("collect", async ({ env, bridge, stores, clock, count }) => {
  const dryRun = env.DRY_RUN;
  if (!dryRun) await syncSources(bridge, SOURCES, clock);

  // A manual dry run fetches and reports but writes nothing.
  const { sourceItems, sourceState } = dryRun ? dryRunCollectStores(stores) : stores;

  const report = await runCollect({
    settings: stores.settings,
    scheduled: env.GITHUB_EVENT_NAME === "schedule",
    sourceState,
    sourceItems,
    clock,
    contactUrl: env.BOT_CONTACT_URL,
    sources: SOURCES,
  });
  if (report.status === "switched_off") {
    appendSummary(`### collect: automatic collecting is PAUSED (${report.reason})\nStart it with Actions -> collect-switch -> start. A manual run always collects.`);
    setOutput("new_items", 0);
    return "skipped";
  }
  count("new_items", report.newItems);
  appendSummary([`### collect${dryRun ? " (dry run, nothing saved)" : ""}: ${report.newItems} new item(s)`, ...report.lines].join("\n"));
  setOutput("new_items", dryRun ? 0 : report.newItems);
  return "succeeded";
});
