import { appendSummary } from "../ops/actions.ts";
import { registerSecret } from "../ops/logger.ts";
import { describeClientError } from "../publishing/errors.ts";
import { createInstagramClient } from "../publishing/instagram-client.ts";
import { toIso } from "../publishing/ist.ts";
import { runJob } from "./context.ts";

const DAY_MS = 86_400_000;
/** Meta refreshes only tokens that are at least 24 hours old. */
const MIN_AGE_MS = DAY_MS;
const WARN_DAYS = 14;

await runJob(
  "token-refresh",
  async ({ env, stores, clock }) => {
    const credentials = await stores.tokens.getInstagram();
    if (credentials === undefined) {
      appendSummary("### token-refresh: no Instagram token imported yet (Phase 2). Nothing to do.");
      return "skipped";
    }
    registerSecret(credentials.accessToken);
    const client = createInstagramClient({
      fetch: globalThis.fetch,
      accessToken: credentials.accessToken,
      api: credentials.api,
      graphVersion: env.IG_GRAPH_VERSION,
    });
    if (credentials.api === "unified_login") {
      // Nothing to refresh, but a revoked token or a lost asset assignment must still fail loudly (OPERATIONS 6.D).
      const quota = await client.getPublishingLimit(credentials.igUserId);
      if (!quota.ok) {
        appendSummary(`### token-refresh FAILED\nMeta refused the Unified login token (${describeClientError(quota.error)}). Publishing is blocked; see OPERATIONS 6.D.`);
        process.exitCode = 1;
        return "succeeded";
      }
      appendSummary("### token-refresh: the Unified login token does not expire, and Meta still accepts it (read-only check). Nothing to refresh.");
      return "succeeded";
    }
    const now = clock.now();
    const daysLeft = (Date.parse(credentials.expiresAt) - now.getTime()) / DAY_MS;
    if (now.getTime() - Date.parse(credentials.obtainedAt) < MIN_AGE_MS) {
      appendSummary("### token-refresh: the token is less than 24 hours old; Meta refreshes it only after that.");
      return "skipped";
    }

    const refreshed = await client.refreshToken();
    if (!refreshed.ok) {
      appendSummary(`### token-refresh FAILED\n${describeClientError(refreshed.error)}\nThe current token expires in ${Math.floor(daysLeft)} day(s).`);
      process.exitCode = 1; // GitHub e-mails the owner about the failed run
      return "succeeded";
    }
    registerSecret(refreshed.value.accessToken);
    await stores.tokens.saveInstagram({
      api: "instagram_login",
      igUserId: credentials.igUserId,
      accessToken: refreshed.value.accessToken,
      obtainedAt: toIso(now),
      expiresAt: toIso(new Date(now.getTime() + refreshed.value.expiresInSeconds * 1000)),
    });
    const newDays = Math.floor(refreshed.value.expiresInSeconds / 86_400);
    appendSummary(`### token-refresh: refreshed; valid for ${newDays} day(s).`);
    if (newDays < WARN_DAYS) process.exitCode = 1;
    return "succeeded";
  },
  { requires: (env) => (env.TOKEN_ENCRYPTION_KEY === undefined ? ["TOKEN_ENCRYPTION_KEY"] : []) },
);
