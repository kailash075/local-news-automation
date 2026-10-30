import { appendSummary } from "../ops/actions.ts";
import { registerSecret } from "../ops/logger.ts";
import { createInstagramClient } from "../publishing/instagram-client.ts";
import { runJob } from "./context.ts";

/** Read-only health report (Coimbatore 360's ig_probe idea). */
await runJob("status", async ({ env, stores, clock }) => {
  const now = clock.now();
  const lines: string[] = ["### ErodeGlitz status"];

  const publishing = await stores.settings.getSwitch("publishing_enabled");
  const collecting = await stores.settings.getSwitch("collecting_enabled");
  lines.push(
    `- Collecting: Sheet switch **${collecting.enabled ? "on" : "off"}** (${collecting.reason}), repository variable ${env.COLLECTING_ENABLED ? "on" : "off"}`,
    `- Publishing: Sheet switch **${publishing.enabled ? "on" : "off"}** (${publishing.reason}), repository variable ${env.PUBLISHING_ENABLED ? "on" : "off"}, dry run ${env.DRY_RUN ? "**on**" : "off"}`,
  );

  for (const status of ["awaiting_caption", "in_review", "approved", "scheduled", "publish_unknown", "publish_failed"] as const) {
    const n = (await stores.stories.listByStatus([status], 500)).length;
    if (n > 0) lines.push(`- Stories ${status}: ${n}`);
  }
  const published24h = await stores.publications.countPublishedSince(new Date(now.getTime() - 24 * 3600_000));
  const last = await stores.publications.lastPublishedAt();
  lines.push(`- Published in the last 24 h: ${published24h}; last post: ${last?.toISOString() ?? "never"}`);
  const unknown = await stores.publications.listByStatus("publish_unknown");
  if (unknown.length > 0) lines.push(`- ⚠ ${unknown.length} publication(s) with an unknown result, waiting for reconciliation`);

  if (env.TOKEN_ENCRYPTION_KEY === undefined) {
    lines.push("- Instagram token: `TOKEN_ENCRYPTION_KEY` not set (Phase 2)");
  } else {
    const credentials = await stores.tokens.getInstagram();
    if (credentials === undefined) {
      lines.push("- Instagram token: none imported yet (Phase 2)");
    } else {
      registerSecret(credentials.accessToken);
      const days = Math.floor((Date.parse(credentials.expiresAt) - now.getTime()) / 86_400_000);
      lines.push(`- Instagram token for @${env.IG_USERNAME}: expires in ${days} day(s)${days < 14 ? " ⚠ refresh now" : ""}`);
      const client = createInstagramClient({ fetch: globalThis.fetch, accessToken: credentials.accessToken, graphVersion: env.IG_GRAPH_VERSION });
      const quota = await client.getPublishingLimit(credentials.igUserId);
      lines.push(
        quota.ok
          ? `- Instagram publishing quota (rolling 24 h): ${quota.value.quotaUsage} used of ${quota.value.quotaTotal ?? "unknown"}`
          : "- Instagram publishing quota: could not be read",
      );
      if (days < 14) process.exitCode = 1;
    }
  }
  appendSummary(lines.join("\n"));
  return "succeeded";
});
