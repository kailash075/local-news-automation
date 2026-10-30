import { err, ok, type Result } from "../lib/result.ts";

export type WorkflowDispatcher = (workflowFile: string, inputs: Readonly<Record<string, string>>) => Promise<Result<void, string>>;

/**
 * Starts another workflow. Runs started with GITHUB_TOKEN through workflow_dispatch are allowed
 * (unlike other events created by GITHUB_TOKEN); the calling workflow needs `actions: write`.
 */
export const createDispatcher = (options: {
  token: string;
  repository: string;
  ref: string;
  fetch?: typeof globalThis.fetch;
}): WorkflowDispatcher => {
  const doFetch = options.fetch ?? globalThis.fetch;
  return async (workflowFile, inputs) => {
    if (!/^[\w.-]+\.ya?ml$/.test(workflowFile)) return err(`invalid workflow file name: ${workflowFile}`);
    try {
      const response = await doFetch(
        `https://api.github.com/repos/${options.repository}/actions/workflows/${workflowFile}/dispatches`,
        {
          method: "POST",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${options.token}`,
            "x-github-api-version": "2022-11-28",
            "content-type": "application/json",
            "user-agent": "erodeglitz-review-desk",
          },
          body: JSON.stringify({ ref: options.ref, inputs }),
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (response.status === 204 || response.ok) return ok(undefined);
      return err(`dispatch ${workflowFile} -> HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    } catch (e) {
      return err(`dispatch ${workflowFile} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
};
