import { z } from "zod";
import { err, ok, type Result } from "../lib/result.ts";

/**
 * Minimal GitHub Issues client for the review desk, using the workflow's GITHUB_TOKEN.
 * Comments created with GITHUB_TOKEN do not start new workflow runs, so the bot never triggers itself.
 */

export type IssueRef = { number: number; body: string; state: "open" | "closed"; title: string };

export type IssuesClient = {
  create: (title: string, body: string, labels: readonly string[]) => Promise<Result<IssueRef, string>>;
  /** Replaces the title and the body; the review desk owns both. */
  update: (issueNumber: number, title: string, body: string) => Promise<Result<void, string>>;
  comment: (issueNumber: number, body: string) => Promise<Result<void, string>>;
  close: (issueNumber: number, reason: "completed" | "not_planned") => Promise<Result<void, string>>;
  /** Fallback when the database lost the issue number: scans recent issues with the label for a hidden marker. */
  findByMarker: (label: string, marker: string) => Promise<Result<IssueRef | undefined, string>>;
};

const IssueSchema = z.object({
  number: z.int(),
  body: z.string().nullable(),
  state: z.enum(["open", "closed"]),
  title: z.string(),
  pull_request: z.unknown().optional(),
});

const toRef = (issue: z.infer<typeof IssueSchema>): IssueRef => ({
  number: issue.number,
  body: issue.body ?? "",
  state: issue.state,
  title: issue.title,
});

/** GitHub rejects issue bodies above 65,536 characters. */
const MAX_BODY = 65_000;

export const createIssuesClient = (options: {
  token: string;
  repository: string;
  fetch?: typeof globalThis.fetch;
}): IssuesClient => {
  const doFetch = options.fetch ?? globalThis.fetch;
  if (!/^[\w.-]+\/[\w.-]+$/.test(options.repository)) throw new Error("GITHUB_REPOSITORY must look like owner/name");
  const base = `https://api.github.com/repos/${options.repository}`;

  const call = async (method: string, path: string, body?: unknown): Promise<Result<unknown, string>> => {
    try {
      const response = await doFetch(`${base}${path}`, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${options.token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "erodeglitz-review-desk",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20_000),
      });
      const text = await response.text();
      if (!response.ok) return err(`GitHub ${method} ${path} -> HTTP ${response.status}: ${text.slice(0, 200)}`);
      return ok(text === "" ? null : (JSON.parse(text) as unknown));
    } catch (e) {
      return err(`GitHub ${method} ${path} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const clip = (body: string): string => (body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n\n(truncated)` : body);

  return {
    create: async (title, body, labels) => {
      const res = await call("POST", "/issues", { title: title.slice(0, 250), body: clip(body), labels });
      if (!res.ok) return res;
      const parsed = IssueSchema.safeParse(res.value);
      return parsed.success ? ok(toRef(parsed.data)) : err("unexpected GitHub response for issue creation");
    },
    update: async (issueNumber, title, body) => {
      const res = await call("PATCH", `/issues/${issueNumber}`, { title: title.slice(0, 250), body: clip(body) });
      return res.ok ? ok(undefined) : res;
    },
    comment: async (issueNumber, body) => {
      const res = await call("POST", `/issues/${issueNumber}/comments`, { body: clip(body) });
      return res.ok ? ok(undefined) : res;
    },
    close: async (issueNumber, reason) => {
      const res = await call("PATCH", `/issues/${issueNumber}`, { state: "closed", state_reason: reason });
      return res.ok ? ok(undefined) : res;
    },
    findByMarker: async (label, marker) => {
      const res = await call("GET", `/issues?state=all&labels=${encodeURIComponent(label)}&per_page=100&sort=created&direction=desc`);
      if (!res.ok) return res;
      const parsed = z.array(IssueSchema).safeParse(res.value);
      if (!parsed.success) return err("unexpected GitHub response for issue list");
      const match = parsed.data.find((i) => i.pull_request === undefined && (i.body ?? "").includes(marker));
      return ok(match === undefined ? undefined : toRef(match));
    },
  };
};
