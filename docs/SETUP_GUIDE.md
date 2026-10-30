# Setup Guide

> **Status, 2026-10-29: nothing in this guide has been set up yet.** Each step is marked:
>
> - **[Manual]**: a person has to do it; the code cannot.
> - **[Approval]**: creates an account, changes a setting, spends money, or can publish. The owner must explicitly approve it first.
> - **[Later phase]**: not needed until the phase named.
>
> Facts about external services were checked on 2026-10-29. Dashboards change, so if a screen differs from this guide, follow the official documentation linked in [INSTAGRAM_COMPLIANCE.md](INSTAGRAM_COMPLIANCE.md#14-references) and update this file.

## 1. What is needed, by phase

| Phase | Service | Account needed | Cost |
|---|---|---|---|
| 0 | GitHub (this repository, Actions) | exists (`kailash075`) | Included compute only |
| 1 | Supabase (Postgres and Storage) | **new**, [Approval] | Free plan |
| 2 | Instagram professional account | `erodeglitz` exists; type to confirm (§5.1) | Free |
| 2 | Meta for Developers (app) | **new or existing**, [Approval] | Free |
| 3 (optional) | Anthropic (Claude API) | **new**, [Approval] | Paid, capped |

## 2. Local development

1. **Node.js 26 LTS.** This machine has v22.23.2. Install Node 26 with your preferred method (nvm, fnm, or the official binaries from nodejs.org). Phase 0 adds a `.node-version` file that version managers and `actions/setup-node` can read. If a dependency turns out not to support Node 26, the fallback is Node 24 LTS.
2. **pnpm 11.** Already installed (11.20.0).
3. **GitHub CLI and git identity.** `gh` 2.100.0 is installed with two accounts. The globally active account is `kailashrajendiran`, which cannot see this repository. Instead of switching globally, this repository has its own local git settings (applied 2026-10-30):

   ```bash
   git remote set-url origin https://kailash075@github.com/kailash075/local-news-automation.git
   git config --local user.name kailash075
   git config --local user.email 17820794+kailash075@users.noreply.github.com
   ```

   The username in the remote URL makes the `gh` credential helper use `kailash075`'s saved login for this repository only; other repositories keep using `kailashrajendiran`.
   - `gh` commands (for example `gh secret set`) use the global account, so run them as `GH_TOKEN="$(gh auth token --user kailash075)" gh ...`, or switch with `gh auth switch --user kailash075` while you work on this project.
   - After the first push, check that the commit shows the `kailash075` avatar on GitHub. If it doesn't, turn on "Keep my email addresses private" at <https://github.com/settings/emails> (older accounts may need this for the ID-based noreply address), or set a different `user.email`.

4. **After Phase 0 exists:**

   ```bash
   pnpm install
   pnpm run typecheck
   pnpm run lint
   pnpm test
   ```

5. **Local environment file.** Copy `.env.example` to `.env` for local experiments. `.env` is already git-ignored. Local runs default to `DRY_RUN=true` and `PUBLISHING_ENABLED=false`. Never put production credentials in `.env` unless you need them for a specific task, and remove them afterwards.

Docker is not required. Database tests use PGlite, an in-process Postgres.

## 3. GitHub repository settings

### 3.1 Confirm the plan [Manual]

Confirmed 2026-10-30: `kailash075` is on **GitHub Free** (GitHub refuses branch protection on this private repository with "Upgrade to GitHub Pro"). On GitHub Free, a private repository has:

- no branch protection;
- USD 12 per month of included Actions compute (Linux 2-core USD 0.006 per minute, `ubuntu-slim` USD 0.002 per minute);
- no environment secrets and no required reviewers or wait timers for environments;
- usage blocked, rather than billed, when the allowance runs out and no payment method is on file.

Do not add a payment method or raise a budget without deciding to spend money.

### 3.2 Actions settings [Manual] [Approval]

Settings, then Actions, then General:

- Allow GitHub Actions for this repository. Restrict third-party actions to the ones the workflows use, if your plan offers that control.
- Workflow permissions: **Read repository contents** (read-only default). Each workflow asks for the extra permissions it needs (`issues: write`, `actions: write`).
- Leave "Allow GitHub Actions to create and approve pull requests" off.

### 3.3 Secrets and variables [Manual] [Later phase]

Settings, then Secrets and variables, then Actions. Set secrets with the CLI so values never appear in shell history: `gh secret set NAME` prompts for the value.

Repository **secrets**:

| Name | Phase | Value |
|---|---|---|
| `DATABASE_URL` | 1 | Supabase **session pooler** connection string for the `newsroom_app` role |
| `SUPABASE_SECRET_KEY` | 1 | Supabase server-side secret key (used for Storage only) |
| `TOKEN_ENCRYPTION_KEY` | 1 | 32 random bytes, base64: `openssl rand -base64 32` |
| `BACKUP_ENCRYPTION_KEY` | 1 | 32 random bytes, base64. Keep an offline copy in your password manager, or backups cannot be restored. |
| `IG_BOOTSTRAP_TOKEN` | 2 | Temporary. Delete it right after the import workflow succeeds. |
| `ANTHROPIC_API_KEY` | 3 | Only if Phase 3 is approved |

Repository **variables** (not secret):

| Name | Default | Meaning |
|---|---|---|
| `PUBLISHING_ENABLED` | `false` | Must be exactly `true` for any publishing to happen |
| `DRY_RUN` | `true` | When `true`, the publisher never calls Instagram |
| `EDITOR_GITHUB_LOGINS` | `kailash075` | Comma-separated logins allowed to run review commands |
| `OWNER_GITHUB_LOGIN` | `kailash075` | The only login that can switch the kill switch off |
| `SUPABASE_URL` | | Project URL |
| `IG_USER_ID` | | Instagram professional account ID (Phase 2) |
| `IG_GRAPH_API_VERSION` | `v26.0` | Pinned Graph API version |
| `POSTING_WINDOW_IST` | `08:00-21:00` | No posts outside this window (owner decision, 2026-10-30) |
| `MAX_POSTS_PER_DAY` | `6` | Always far below Meta's quota |
| `MIN_MINUTES_BETWEEN_POSTS` | `30` | |
| `APPROVAL_TTL_HOURS` | `12` | |
| `LLM_ENABLED` | `false` | Phase 3 |
| `LLM_MODEL` | `claude-opus-5-5` | Phase 3; change only after the evaluation |
| `LLM_MONTHLY_BUDGET_USD` | `0` | Phase 3; the code refuses LLM calls once this is reached |
| `AUTO_PUBLISH_CATEGORIES` | empty | Phase 4; empty means nothing is auto-published |

## 4. Supabase (Phase 1) [Approval]

> Approved by the owner on 2026-10-30. The owner signs up at the start of Phase 1; nothing has been created yet.

1. Create a Supabase account and a Free-plan organisation. Free covers 2 projects, a 500 MB database, 1 GB file storage and 5 GB egress. Do not add a card.
2. Create a project named `erodeglitz-prod`.
   - **Region:** GitHub-hosted runners run in Azure data centres that you cannot choose. A region far from the runners adds latency to every query. Pick a region, then measure job duration in the first week of Phase 1; moving early is cheap while the data is small. If you require data to stay in India, choose Mumbai and accept slower jobs; the job design batches queries to limit the impact.
   - Save the database password in a password manager.
3. **Connection string.** Use the **session pooler** connection string, which works over IPv4. Supabase's direct database connection is IPv6-only unless you buy the IPv4 add-on, and Supabase's own documentation lists GitHub Actions among IPv4-only environments.
4. **Database role and schema.** The Phase 1 migrations create schema `newsroom` and a least-privilege role `newsroom_app`. Put that role's pooler connection string in `DATABASE_URL`. The schema is not exposed through Supabase's Data API, and row-level security is enabled anyway.
5. **Storage.** Create a **private** bucket named `renders`, or let the Phase 1 setup script create it. Never make it public; Meta receives short-lived signed URLs.
6. **Keys.** Copy the project URL to the `SUPABASE_URL` variable and a server-side secret key to the `SUPABASE_SECRET_KEY` secret. Never use a server-side key in browser code.
7. **Inactivity pausing.** Supabase pauses Free projects after low activity over a 7-day period. The hourly jobs keep the project active. If jobs are disabled for more than a few days, expect a pause and follow the restore steps in [Operations §6](OPERATIONS.md#6-incident-runbooks).
8. **Backups.** Free projects have no backups you can rely on, so the weekly encrypted export job ([Operations §7](OPERATIONS.md#7-backups-and-restore)) is required, not optional.

## 5. Meta and Instagram (Phase 2) [Approval]

Nothing in this section publishes anything. Publishing starts only after the go-live checklist in [Operations §11](OPERATIONS.md#11-release-and-change-management) and the owner's explicit approval of the first post.

### 5.1 Instagram account [Manual]

1. Make sure the `erodeglitz` Instagram account is a **professional account** (Business or Creator). To check, in the Instagram app go to your profile, tap ☰ (top right), then **Settings and activity**, then **For professionals**, then **Account type and tools**:
   - "Switch to professional account" is offered: the account is **Personal**. Switch it before Phase 2 (free, same menu). You make this change, not the software.
   - "Switch to creator account" is offered: it is **Business**.
   - "Switch to business account" is offered: it is **Creator**.
   - A **Professional dashboard** button on the profile also means Business or Creator. Labels vary a little between app versions.

   Business and Creator both work with the API, so there is no need to switch between them. When switching from Personal, Business with a news or media category suits a news page.
2. Turn on two-factor authentication and store the recovery codes offline.
3. Fill in the bio honestly. A short line such as "Erode local news in Tamil. AI-assisted drafts, edited by humans." covers transparency once Phase 3 is active. Add a corrections and complaints contact.

### 5.2 Meta app [Manual] [Approval]

1. Sign in at <https://developers.facebook.com> and register as a developer if you have not already. Turn on two-factor authentication for that account.
2. Create an app of type **Business**. Meta's get-started guide says an existing non-Business app cannot be used; create a new one.
3. Add the Instagram product and open **API setup with Instagram business login**.
4. Fill in App Settings: app name, contact email, app icon and **privacy policy URL**. Meta's App Review page lists the privacy policy URL as an App Settings field. The page will be hosted with GitHub Pages from a new public repository, for example `kailash075/erodeglitz-site` (owner decision, 2026-10-30). GitHub Free cannot publish Pages from this private repository, and creating the new repository needs the owner's approval.
5. Permissions needed: `instagram_business_basic` and `instagram_business_content_publish`. **Do not** request Advanced Access or submit App Review. Meta's App Review table says App Review is not required when the app is "only for a business I own or manage".
6. App mode (development or live): the Instagram pages checked did not say whether publishing to your own account works in development mode. Record what the dashboard shows during setup, and switch to live mode only if it is required and after the privacy policy page exists. [Approval]

### 5.3 Token [Manual] [Approval]

1. In the app dashboard, under Instagram, then **API setup with Instagram business login**, click **Generate token** next to the ErodeGlitz account and log in to Instagram. Dashboard tokens are long-lived and valid for 60 days.
2. Do not paste the token into chat, issues, `.env` files or commit messages. Store it directly as a temporary GitHub secret:

   ```bash
   gh secret set IG_BOOTSTRAP_TOKEN --repo kailash075/local-news-automation
   ```

3. Run the **Import Instagram token** workflow (`import-token.yml`, added in Phase 2). It checks the token with a read-only call, encrypts it into the database, and writes the token expiry date to the job summary.
4. Delete the temporary secret:

   ```bash
   gh secret delete IG_BOOTSTRAP_TOKEN --repo kailash075/local-news-automation
   ```

5. The weekly `token-refresh.yml` job calls `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token`. Meta requires the token to be at least 24 hours old, unexpired, and to carry `instagram_business_basic`. A token that is not refreshed within 60 days expires and cannot be refreshed; you would then generate a new one (steps 1 to 4).

### 5.4 Read-only verification [Manual]

Phase 2 adds `pnpm run job:ig-check`, which performs **read-only** calls:

- `GET /me?fields=user_id,username`: confirms the account. Put `user_id` in the `IG_USER_ID` variable.
- `GET /<IG_USER_ID>/content_publishing_limit`: shows the live quota. Meta's pages give conflicting numbers (50 and 100 posts per 24 hours); the live value is the one that counts.

No container is created and nothing is published by this check.

## 6. Anthropic (Phase 3, optional) [Approval]

1. Create a Claude Console account and an organisation, and add billing. This spends money, so it needs explicit approval with a monthly budget.
2. Create a workspace named `erodeglitz` and set a **workspace spend limit** equal to the approved budget. This is the final backstop.
3. Create an API key in that workspace, then `gh secret set ANTHROPIC_API_KEY`.
4. Set the variables `LLM_ENABLED=true`, `LLM_MONTHLY_BUDGET_USD=<approved amount>` and `LLM_MODEL` (default `claude-opus-5-5` until the evaluation suggests otherwise). The code enforces its own cap below the Console limit.

## 7. Verification checklist

### Phase 0

- [ ] `pnpm install --frozen-lockfile`, typecheck, lint and test pass locally on Node 26
- [ ] CI passes on GitHub
- [ ] Sample Tamil graphics approved by the owner
- [ ] Runner spike durations recorded in OPERATIONS.md

### Phase 1

- [ ] Supabase project created after approval; migrations applied
- [ ] Secrets and variables set; `PUBLISHING_ENABLED=false`, `DRY_RUN=true`
- [ ] First sources reviewed and approved in the registry
- [ ] Scheduled pipeline creates review issues; commands work from the GitHub mobile app
- [ ] Dry-run publisher records "would publish" decisions
- [ ] Backup export and a test restore into a scratch database both succeed

### Phase 2

- [ ] Meta app and token created by the owner after approval
- [ ] Token imported; temporary secret deleted
- [ ] `job:ig-check` shows the right username and the live quota
- [ ] Go-live checklist completed ([Operations §11](OPERATIONS.md#11-release-and-change-management))
- [ ] First post explicitly approved by the owner

## 8. Not set up (as of 2026-10-30)

- No Supabase account or project (approved, not created).
- No Meta developer app and no token. The `erodeglitz` Instagram account exists, but its type is not confirmed.
- No Anthropic account or API key.
- No GitHub secrets, variables, labels, issue templates or workflows.
- No privacy policy page or `erodeglitz-site` repository.
- The global active `gh` account is still `kailashrajendiran`; this repository uses local settings for `kailash075` instead (§2).
