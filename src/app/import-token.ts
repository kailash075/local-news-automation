import type { Clock, InstagramApi, InstagramCredentials, TokenStore } from "../domain/ports.ts";
import type { GitHubLogin, IsoDateTime } from "../domain/types.ts";
import { err, ok, type Result } from "../lib/result.ts";
import { describeClientError } from "../publishing/errors.ts";
import type { AccountInfo, InstagramClient, InstagramClientError, PublishingLimit } from "../publishing/instagram-client.ts";
import { toIso } from "../publishing/ist.ts";

/**
 * Phase 2 token import (SETUP_GUIDE §6.3). The owner generates a token in the Meta dashboard and stores it as the temporary
 * IG_BOOTSTRAP_TOKEN secret; this checks it with read-only calls and keeps it, encrypted, in the bridge's Script
 * properties. Nothing is posted.
 */

/**
 * Instagram login only. Meta: "Access tokens from the App Dashboard are long-lived and are valid for 60 days"
 * (get-started guide, read 2026-10-31). A Unified login token does not expire.
 */
export const DASHBOARD_TOKEN_DAYS = 60;

/** One line of printable characters without spaces. */
const TOKEN_SHAPE = /^[\x21-\x7e]{20,4096}$/;

export type ImportRequest = { token: string; actor: string };

export type ImportDeps = {
  tokens: TokenStore;
  clock: Clock;
  createClient: (accessToken: string, api: InstagramApi) => InstagramClient;
  /** IG_USERNAME: the only account this pipeline serves. */
  username: string;
  owner: GitHubLogin | undefined;
};

/**
 * `expiresAt` is absent for a Unified login token, which does not expire. For an Instagram login token it is Meta's
 * stated lifetime counted from now; the first weekly refresh replaces it with Meta's exact figure.
 */
export type ImportedToken = { username: string; api: InstagramApi; expiresAt?: IsoDateTime; quota: PublishingLimit };

type Probe = { api: InstagramApi; client: InstagramClient; accounts: Result<readonly AccountInfo[], InstagramClientError> };

const probe = async (deps: ImportDeps, token: string, api: InstagramApi): Promise<Probe> => {
  const client = deps.createClient(token, api);
  return { api, client, accounts: await client.listAccounts() };
};

export const importToken = async (deps: ImportDeps, request: ImportRequest): Promise<Result<ImportedToken, string>> => {
  if (deps.owner === undefined || request.actor !== deps.owner) {
    return err("Only the owner (OWNER_GITHUB_LOGIN) can import the Instagram token.");
  }
  if (!TOKEN_SHAPE.test(request.token)) {
    return err("IG_BOOTSTRAP_TOKEN does not look like a token: it should be one line without spaces. Copy only the token from the Meta dashboard and set the secret again.");
  }

  // Meta gives new apps only Unified login, so that is tried first; a token from the older Instagram login still works.
  const unified = await probe(deps, request.token, "unified_login");
  const found = unified.accounts.ok ? unified : await probe(deps, request.token, "instagram_login");
  if (!found.accounts.ok) {
    const unifiedError = unified.accounts.ok ? "" : describeClientError(unified.accounts.error);
    return err(`Meta did not accept the token. Unified login: ${unifiedError}. Instagram login: ${describeClientError(found.accounts.error)}.`);
  }
  // Other accounts are not named: the run summary of this public repository is public.
  const account = found.accounts.value.find((a) => a.username.toLowerCase() === deps.username.toLowerCase());
  if (account === undefined) {
    return err(
      `The token does not give access to @${deps.username}. For a system user's token, check in Business settings that the system user has the ${deps.username} Instagram account assigned; otherwise generate the token for the ${deps.username} account.`,
    );
  }
  const quota = await found.client.getPublishingLimit(account.userId);
  if (!quota.ok) return err(`The publishing quota could not be read (${describeClientError(quota.error)}).`);
  // The publisher's first live call reads recent posts (duplicate guard); a permission error there would trip the kill switch.
  const media = await found.client.listRecentMedia(account.userId, 1);
  if (!media.ok) return err(`The account's posts could not be read (${describeClientError(media.error)}).`);

  const now = deps.clock.now();
  const base = { igUserId: account.userId, accessToken: request.token, obtainedAt: toIso(now) };
  const credentials: InstagramCredentials =
    found.api === "unified_login"
      ? { ...base, api: "unified_login" }
      : { ...base, api: "instagram_login", expiresAt: toIso(new Date(now.getTime() + DASHBOARD_TOKEN_DAYS * 86_400_000)) };
  await deps.tokens.saveInstagram(credentials);
  const stored = await deps.tokens.getInstagram();
  if (stored?.accessToken !== credentials.accessToken || stored.igUserId !== credentials.igUserId || stored.api !== credentials.api) {
    throw new Error("the Instagram token was saved but could not be read back");
  }
  return ok({
    username: account.username,
    api: credentials.api,
    quota: quota.value,
    ...(credentials.api === "instagram_login" ? { expiresAt: credentials.expiresAt } : {}),
  });
};
