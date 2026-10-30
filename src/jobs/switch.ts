import { SwitchRequestSchema, applySwitch } from "../app/switch.ts";
import { appendSummary } from "../ops/actions.ts";
import { runJob } from "./context.ts";

await runJob("switch", async ({ env, stores }) => {
  const request = SwitchRequestSchema.parse({
    name: process.env["SWITCH_NAME"],
    state: process.env["SWITCH_STATE"],
    reason: process.env["SWITCH_REASON"],
    actor: process.env["ACTOR"],
  });
  const result = await applySwitch(stores.settings, request, env.OWNER_GITHUB_LOGIN);
  if (!result.ok) {
    appendSummary(`### Switch refused\n${result.error}`);
    process.exitCode = 1;
    return "skipped";
  }
  appendSummary(`### ${result.value}`);
  if (request.name === "publishing" && request.state === "on") {
    appendSummary(
      "Publishing also needs the repository variable `PUBLISHING_ENABLED` = `true` and `DRY_RUN` = `false`. Until both are set, nothing is posted.",
    );
  }
  return "succeeded";
});
