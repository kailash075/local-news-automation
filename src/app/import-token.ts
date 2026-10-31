import type { Clock, InstagramCredentials, TokenStore } from "../domain/ports.ts";
import type { GitHubLogin, IsoDateTime } from "../domain/types.ts";
import { err, ok, type Result } from "../lib/result.ts";
import { describeClientError } from "../publishing/errors.ts";
import type { InstagramClient, PublishingLimit } from "../publishing/instagram-client.ts";
import { toIso } from "../publishing/ist.ts";

/**
 * Phase 2 token import (SETUP_GUIDE §6.3). The owner generates a token in the Meta dashboard and stores it as the temporary
 * IG_BOOTSTRAP_TOKEN secret; this checks it with read-only calls and keeps it, encrypted, in the bridge's Script
 * properties. Nothing is posted.
 */

/** Meta: "Access tokens from the App Dashboard are long-lived and are valid for 60 days" (get-started guide, read 2026-10-31). */
export const DASHBOARD_TOKEN_DAYS = 60;

/** One line of printable characters without spaces. */
const TOKEN_SHAPE = /^[\x21-\x7e]{20,4096}$/;

export type ImportRequest = { token: string; actor: string };

export type ImportDeps = {
  tokens: TokenStore;
  clock: Clock;
  createClient: (accessToken: string) => InstagramClient;
  /** IG_USERNAME: the only account this pipeline serves. */
  username: string;
  owner: GitHubLogin | undefined;
};

/** `expiresAt` is Meta's stated lifetime counted from now; the first weekly refresh replaces it with Meta's exact figure. */
export type ImportedToken = { username: string; expiresAt: IsoDateTime; quota: PublishingLimit };

export const importToken = async (deps: ImportDeps, request: ImportRequest): Promise<Result<ImportedToken, string>> => {
  if (deps.owner === undefined || request.actor !== deps.owner) {
    return err("Only the owner (OWNER_GITHUB_LOGIN) can import the Instagram token.");
  }
  if (!TOKEN_SHAPE.test(request.token)) {
    return err("IG_BOOTSTRAP_TOKEN does not look like a token: it should be one line without spaces. Copy only the token from the Meta dashboard and set the secret again.");
  }

  const client = deps.createClient(request.token);
  const account = await client.getAccount();
  if (!account.ok) {
    const hint = request.token.startsWith("EAA")
      ? " This looks like a Facebook token; generate it under Instagram, API setup with Instagram business login."
      : "";
    return err(`Meta did not accept the token (${describeClientError(account.error)}).${hint}`);
  }
  // The other account's name is not repeated: the run summary of this public repository is public.
  if (account.value.username.toLowerCase() !== deps.username.toLowerCase()) {
    return err(`The token belongs to another Instagram account, not @${deps.username}. Generate it next to the ${deps.username} account.`);
  }
  const quota = await client.getPublishingLimit(account.value.userId);
  if (!quota.ok) return err(`The publishing quota could not be read (${describeClientError(quota.error)}).`);

  const now = deps.clock.now();
  const credentials: InstagramCredentials = {
    igUserId: account.value.userId,
    accessToken: request.token,
    obtainedAt: toIso(now),
    expiresAt: toIso(new Date(now.getTime() + DASHBOARD_TOKEN_DAYS * 86_400_000)),
  };
  await deps.tokens.saveInstagram(credentials);
  const stored = await deps.tokens.getInstagram();
  if (stored?.accessToken !== credentials.accessToken || stored.igUserId !== credentials.igUserId) {
    throw new Error("the Instagram token was saved but could not be read back");
  }
  return ok({ username: account.value.username, expiresAt: credentials.expiresAt, quota: quota.value });
};
