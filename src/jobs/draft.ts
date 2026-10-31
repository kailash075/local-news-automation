import { scheduledRunPaused } from "../app/collect-switch.ts";
import { MAX_NEW_ISSUES_PER_RUN, runDrafts, pendingDraftWork } from "../app/draft.ts";
import { runTriage } from "../app/triage.ts";
import { createImagesFromEnv, missingForImages } from "../config/env.ts";
import { sourceById } from "../config/sources.ts";
import { createIssuesClient } from "../github/issues.ts";
import { createRenderer, type Renderer } from "../graphics/render.ts";
import { appendSummary, setOutput } from "../ops/actions.ts";
import { runJob } from "./context.ts";

const checkOnly = process.env["DRAFT_MODE"] === "check";
const onlyStoryId = (process.env["STORY_ID"] ?? "").trim() || undefined;
const refreshIssues = process.env["REFRESH_ISSUES"] === "true";

await runJob(
  checkOnly ? "draft-check" : "draft",
  async ({ env, stores, clock, count }) => {
    const token = process.env["GH_TOKEN"];
    if (token === undefined || env.GITHUB_REPOSITORY === undefined) throw new Error("GH_TOKEN and GITHUB_REPOSITORY are required");
    const issues = createIssuesClient({ token, repository: env.GITHUB_REPOSITORY });

    if (checkOnly) {
      const paused = await scheduledRunPaused(stores.settings, env.GITHUB_EVENT_NAME === "schedule");
      if (paused !== undefined) {
        setOutput("pending", 0);
        appendSummary(`### draft check: automatic collecting is PAUSED (${paused}), so the safety-net run stops here`);
        return "skipped";
      }
      const check = await pendingDraftWork({ stores, clock, issues }, onlyStoryId, refreshIssues);
      count("expired", check.expired);
      setOutput("pending", check.pending);
      appendSummary(
        [
          `### draft check: ${check.pending} item(s) of work`,
          ...(check.expired === 0 ? [] : [`Expired, issues closed: ${check.expired} (not approved within 48 hours, or the notice's day is over).`]),
          ...check.problems.map((p) => `- problem: ${p}`),
        ].join("\n"),
      );
      return check.pending === 0 && check.expired === 0 ? "skipped" : "succeeded";
    }

    const triage = await runTriage({ stores, clock, maxAgeHours: env.MAX_STORY_AGE_HOURS, sourceFor: sourceById });
    count("new_stories", triage.newStories);

    let renderer: Renderer | undefined;
    try {
      const report = await runDrafts(
        {
          stores,
          clock,
          sourceFor: sourceById,
          objects: createImagesFromEnv(env),
          issues,
          renderer: async () => (renderer ??= await createRenderer()),
        },
        onlyStoryId,
        refreshIssues,
      );
      count("revisions", report.revisions);
      count("expired", report.expired);
      appendSummary(
        [
          `### draft`,
          `Items triaged: ${triage.items} (new stories ${triage.newStories}, joined existing ${triage.attached}, discarded ${triage.discarded})`,
          ...triage.lines,
          `Revisions rendered: ${report.revisions}. Issues created: ${report.issuesCreated}, updated: ${report.issuesUpdated}.` +
            (report.deferred === 0 ? "" : ` ${report.deferred} more stories wait for the next run (at most ${MAX_NEW_ISSUES_PER_RUN} new issues a run).`) +
            (report.expired === 0 ? "" : ` Expired, issues closed: ${report.expired}.`),
          ...report.problems.map((p) => `- problem: ${p}`),
        ].join("\n"),
      );
    } finally {
      await renderer?.close();
    }
    return "succeeded";
  },
  { requires: (env) => (checkOnly ? [] : missingForImages(env)) },
);
