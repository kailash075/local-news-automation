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
    if (checkOnly) {
      const pending = await pendingDraftWork({ stores }, onlyStoryId, refreshIssues);
      setOutput("pending", pending);
      appendSummary(`### draft check: ${pending} item(s) of work`);
      return pending === 0 ? "skipped" : "succeeded";
    }

    const triage = await runTriage({ stores, clock, maxAgeHours: env.MAX_STORY_AGE_HOURS, sourceFor: sourceById });
    count("new_stories", triage.newStories);

    const token = process.env["GH_TOKEN"];
    if (token === undefined || env.GITHUB_REPOSITORY === undefined) throw new Error("GH_TOKEN and GITHUB_REPOSITORY are required");
    let renderer: Renderer | undefined;
    try {
      const report = await runDrafts(
        {
          stores,
          clock,
          sourceFor: sourceById,
          objects: createImagesFromEnv(env),
          issues: createIssuesClient({ token, repository: env.GITHUB_REPOSITORY }),
          renderer: async () => (renderer ??= await createRenderer()),
        },
        onlyStoryId,
        refreshIssues,
      );
      count("revisions", report.revisions);
      appendSummary(
        [
          `### draft`,
          `Items triaged: ${triage.items} (new stories ${triage.newStories}, joined existing ${triage.attached}, discarded ${triage.discarded})`,
          ...triage.lines,
          `Revisions rendered: ${report.revisions}. Issues created: ${report.issuesCreated}, updated: ${report.issuesUpdated}.` +
            (report.deferred === 0 ? "" : ` ${report.deferred} more stories wait for the next run (at most ${MAX_NEW_ISSUES_PER_RUN} new issues a run).`),
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
