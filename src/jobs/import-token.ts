import { DASHBOARD_TOKEN_DAYS, importToken } from "../app/import-token.ts";
import { appendSummary } from "../ops/actions.ts";
import { istDateOf } from "../pipeline/freshness.ts";
import { createInstagramClient } from "../publishing/instagram-client.ts";
import { runJob } from "./context.ts";

await runJob(
  "import-token",
  async ({ env, stores, clock }) => {
    const result = await importToken(
      {
        tokens: stores.tokens,
        clock,
        username: env.IG_USERNAME,
        owner: env.OWNER_GITHUB_LOGIN,
        createClient: (accessToken) => createInstagramClient({ fetch: globalThis.fetch, accessToken, graphVersion: env.IG_GRAPH_VERSION }),
      },
      { token: env.IG_BOOTSTRAP_TOKEN ?? "", actor: process.env["ACTOR"] ?? "" },
    );
    if (!result.ok) {
      appendSummary(`### import-token: nothing stored\n${result.error}`);
      process.exitCode = 1;
      return "skipped";
    }
    const { username, expiresAt, quota } = result.value;
    const d = istDateOf(new Date(expiresAt));
    appendSummary(
      [
        `### import-token: token stored for @${username}`,
        "- Checked with read-only calls; nothing was posted.",
        "- Stored encrypted in the Sheet bridge's Script properties, not in a Sheet tab.",
        `- Valid until about ${d.day}.${d.month}.${d.year} (Meta: dashboard tokens last ${DASHBOARD_TOKEN_DAYS} days). The weekly token-refresh run sets the exact date.`,
        `- Instagram publishing quota (rolling 24 h): ${quota.quotaUsage} used of ${quota.quotaTotal ?? "unknown"}`,
        "",
        "**Next:** delete the temporary secret `IG_BOOTSTRAP_TOKEN` (Settings, Secrets and variables, Actions).",
      ].join("\n"),
    );
    return "succeeded";
  },
  {
    requires: (env) => [
      ...(env.TOKEN_ENCRYPTION_KEY === undefined ? ["TOKEN_ENCRYPTION_KEY"] : []),
      ...(env.IG_BOOTSTRAP_TOKEN === undefined ? ["IG_BOOTSTRAP_TOKEN"] : []),
    ],
  },
);
