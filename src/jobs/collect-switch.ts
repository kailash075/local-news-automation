import { CollectSwitchRequestSchema, applyCollectSwitch } from "../app/collect-switch.ts";
import { appendSummary } from "../ops/actions.ts";
import { runJob } from "./context.ts";

await runJob("collect-switch", async ({ env, stores }) => {
  const request = CollectSwitchRequestSchema.parse({ collect: process.env["COLLECT"], actor: process.env["ACTOR"] });
  const result = await applyCollectSwitch(stores.settings, request, env.OWNER_GITHUB_LOGIN);
  if (!result.ok) {
    appendSummary(`### collect-switch refused\n${result.error}`);
    process.exitCode = 1;
    return "skipped";
  }
  appendSummary(`### ${result.value}`);
  return "succeeded";
});
