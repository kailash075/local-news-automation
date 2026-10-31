import { z } from "zod";
import { handleComment } from "../app/review.ts";
import { liveFileExists } from "../config/live.ts";
import { createDispatcher } from "../github/dispatch.ts";
import { createIssuesClient } from "../github/issues.ts";
import { log } from "../ops/logger.ts";
import { runJob } from "./context.ts";

/** The comment arrives through environment variables only; it is never interpolated into a shell command. */
const CommentEnvSchema = z.object({
  COMMENT_BODY: z.string().max(65_536),
  COMMENT_ID: z.coerce.number().int().positive(),
  COMMENT_AUTHOR: z.string().min(1),
  AUTHOR_ASSOCIATION: z.string().min(1),
  ISSUE_NUMBER: z.coerce.number().int().positive(),
  GH_TOKEN: z.string().min(1),
  GITHUB_REPOSITORY: z.string().min(1),
});

await runJob("review-command", async ({ env, stores, clock, count }) => {
  const e = CommentEnvSchema.parse(process.env);
  const issues = createIssuesClient({ token: e.GH_TOKEN, repository: e.GITHUB_REPOSITORY });
  const dispatch = createDispatcher({ token: e.GH_TOKEN, repository: e.GITHUB_REPOSITORY, ref: process.env["GITHUB_REF_NAME"] ?? "master" });

  const result = await handleComment(
    { env, live: liveFileExists(), stores, clock, dispatch },
    { body: e.COMMENT_BODY, commentId: e.COMMENT_ID, author: e.COMMENT_AUTHOR, authorAssociation: e.AUTHOR_ASSOCIATION, issueNumber: e.ISSUE_NUMBER },
  );
  count("commands");
  if (result.reply !== undefined) {
    const posted = await issues.comment(e.ISSUE_NUMBER, result.reply);
    if (!posted.ok) log.warn("could not reply on the issue", { error: posted.error });
  }
  log.info("review command handled", { issue: e.ISSUE_NUMBER, dispatched: result.dispatched });
  return "succeeded";
});
