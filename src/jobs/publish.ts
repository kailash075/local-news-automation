import { setTimeout as sleep } from "node:timers/promises";
import { createImagesFromEnv, missingForImages } from "../config/env.ts";
import { liveFileExists } from "../config/live.ts";
import { createContentChecker, describeOutcome } from "../app/publish.ts";
import { createIssuesClient } from "../github/issues.ts";
import { appendSummary, setOutput } from "../ops/actions.ts";
import { log, registerSecret } from "../ops/logger.ts";
import { createInstagramClient } from "../publishing/instagram-client.ts";
import { publishOne, reconcileUnknown } from "../publishing/publisher.ts";
import { runJob } from "./context.ts";

await runJob(
  "publish",
  async ({ env, stores, clock, count }) => {
    const objects = createImagesFromEnv(env);
    const leaseOwner = `gha-${env.GITHUB_RUN_ID}-${process.env["GITHUB_RUN_ATTEMPT"] ?? "1"}`;
    const createClient = (accessToken: string) => {
      registerSecret(accessToken);
      return createInstagramClient({ fetch: globalThis.fetch, accessToken, graphVersion: env.IG_GRAPH_VERSION });
    };
    const common = { env, live: liveFileExists(), stores, createClient, clock, sleep: (ms: number) => sleep(ms), leaseOwner };

    // Unknown outcomes first: nothing new is published while an earlier result is unclear.
    if (!env.DRY_RUN) {
      const report = await reconcileUnknown({ ...common, claimById: stores.publications.claimById });
      if (report.checked > 0) appendSummary(`Reconciliation: ${JSON.stringify(report)}`);
    }

    const outcome = await publishOne({
      ...common,
      objects,
      checkContent: createContentChecker({ stores, objects, clock }),
    });
    count(`outcome_${outcome.kind}`);
    const line = describeOutcome(outcome);
    appendSummary(`### publish ${env.DRY_RUN ? "(dry run)" : ""}\n${line}`);
    setOutput("outcome", outcome.kind);
    log.info("publish outcome", { outcome: outcome.kind });

    if (outcome.kind !== "idle" && env.GITHUB_REPOSITORY !== undefined && process.env["GH_TOKEN"] !== undefined) {
      const publication = await stores.publications.get(outcome.publicationId);
      const issue = publication === undefined ? undefined : await stores.reviewThreads.getIssueNumber(publication.storyId);
      if (issue !== undefined) {
        const issues = createIssuesClient({ token: process.env["GH_TOKEN"], repository: env.GITHUB_REPOSITORY });
        const posted = await issues.comment(issue, `**Publisher${env.DRY_RUN ? " (dry run)" : ""}:** ${line}`);
        if (!posted.ok) log.warn("could not comment on the issue", { error: posted.error });
      }
    }
    return "succeeded";
  },
  { requires: missingForImages },
);
