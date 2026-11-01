# Setup Guide

> **Status, 2026-11-01: §4 (Google Sheet and Apps Script bridge) and §5 (Cloudinary) are done, and the five newspaper sources are approved. Not live: no `LIVE` file, automatic collecting paused. Phase 2 (§6, Meta and Instagram) is under way: the Meta app, the business portfolio and the token exist; importing the token is next.** Each step is marked:
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
| 1 | Google Sheet and Apps Script (storage, like Coimbatore 360) | `erodeglitz@gmail.com` Google account exists; the Sheet is **new** | Free |
| 1 | Cloudinary (card images) | **new**, [Approval] | Free plan |
| 2 | Instagram professional account | `erodeglitz`, Creator account (2026-10-30) | Free |
| 2 | Meta for Developers (app) and business portfolio | the owner's existing Facebook account; app and portfolio **new** (2026-10-31) | Free |
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

4. **Checks** (Phase 0 code exists since 2026-10-30):

   ```bash
   pnpm install
   pnpm run typecheck
   pnpm run lint
   pnpm test
   pnpm run render:samples   # writes sample Tamil cards to out/samples/
   ```

   Render tests need the Chromium headless shell: `pnpm exec playwright-core install chromium-headless-shell`.

5. **Local environment file.** Copy `.env.example` to `.env` for local experiments. `.env` is already git-ignored. Local runs are dry runs unless `DRY_RUN=false`, and nothing posts without a `LIVE` file. Never put production credentials in `.env` unless you need them for a specific task, and remove them afterwards.

Docker is not required. The storage tests run the real bridge code (`apps-script/Code.gs`) against an in-memory fake Google Sheet.

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
| `SHEET_BRIDGE_URL` | 1 | The Apps Script web app URL, ending in `/exec` (§4, step 6) |
| `SHEET_BRIDGE_KEY` | 1 | The same value as the Script property `BRIDGE_KEY` (§4, steps 4 and 5) |
| `CLOUDINARY_CLOUD_NAME` | 1 | Cloudinary dashboard (§5). Not really secret (it is in every image link), but kept with the other two Cloudinary values, as in Coimbatore 360. |
| `CLOUDINARY_API_KEY` | 1 | Cloudinary dashboard (§5) |
| `CLOUDINARY_API_SECRET` | 1 | Cloudinary dashboard (§5) |
| `TOKEN_ENCRYPTION_KEY` | 2 | 32 random bytes, base64. Create it with `openssl rand -base64 32 \| gh secret set TOKEN_ENCRYPTION_KEY --repo kailash075/local-news-automation`, so the value is never shown. No copy is needed: if it is ever lost or changed, the stored token cannot be read, so generate and import a new token (§6.3). |
| `IG_BOOTSTRAP_TOKEN` | 2 | Temporary. Read only by `import-token.yml`; delete it right after that workflow succeeds (§6.3). |
| `ANTHROPIC_API_KEY` | 3 | Only if Phase 3 is approved |

Repository **variables** (not secret). The names match what the workflows in `.github/workflows/` read; [Workflows §4](WORKFLOWS.md#4-switches) explains the switches.

| Name | Default when not set | Meaning |
|---|---|---|
| `PAUSED` | not set | `true` stops all posting (Coimbatore 360's full stop). Going live is not a variable: it is the `LIVE` file ([Workflows §4](WORKFLOWS.md#4-switches)). |
| `PUBLISH_ON_APPROVAL` | off | When `true`, an approval starts `publish.yml` at once (only while live) |
| `EDITOR_GITHUB_LOGINS` | none (nobody can run commands) | Comma-separated logins allowed to run review commands. Set to `kailash075`. |
| `OWNER_GITHUB_LOGIN` | none (nobody can start collecting or switch the kill switch off) | The only login that can start automatic collecting (**collect-switch**) and switch the kill switch off. Set to `kailash075`. |
| `CLOUDINARY_FOLDER` | `erodeglitz` | Folder for card images in Cloudinary |
| `IG_GRAPH_VERSION` | `v26.0` | Pinned Graph API version |
| `POSTING_WINDOW_IST` | `08:00-21:00` | No posts outside this window (owner decision, 2026-10-30) |
| `MAX_POSTS_PER_DAY` | `6` | Always far below Meta's quota |
| `MIN_MINUTES_BETWEEN_POSTS` | `30` | |
| `APPROVAL_TTL_HOURS` | `12` | |
| `MAX_STORY_AGE_HOURS` | `36` | Older stories are not drafted or published |
| `LLM_ENABLED` | `false` | Phase 3 (not implemented) |
| `LLM_MODEL` | `claude-opus-5-5` | Phase 3; change only after the evaluation |
| `LLM_MONTHLY_BUDGET_USD` | `0` | Phase 3; the code refuses LLM calls once this is reached |
| `AUTO_PUBLISH_CATEGORIES` | empty | Phase 4; empty means nothing is auto-published |

The Instagram account is fixed in code as `erodeglitz` (`IG_USERNAME`); its numeric account ID is stored with the encrypted token in Phase 2.

## 4. Google Sheet and Apps Script bridge (Phase 1) [Approval]

> Owner decision, 2026-10-30: use a Google Sheet as storage, the same way Coimbatore 360 does. It replaces the Supabase plan. Done on 2026-10-30.

The jobs never touch the Sheet directly. A small Apps Script web app inside the Sheet (the "bridge", `apps-script/Code.gs`) receives their requests, checks a key, and reads or writes rows while holding a lock, so two jobs cannot overwrite each other.

1. **Google account.** Sign in to Google as `erodeglitz@gmail.com`. Turn on two-factor authentication for this account first: the Sheet holds every editorial decision, and the bridge holds the encrypted Instagram token.
2. **Sheet.** Create a blank Google Sheet named `ErodeGlitz Newsroom`. Do not share it with anyone. Leave it empty; the migrate workflow creates the tabs.
3. **Bridge code.** In the Sheet, open **Extensions → Apps Script**. A new tab opens with "Untitled project" and `Code.gs`.
   - Click **Untitled project** and rename it `ErodeGlitz bridge`.
   - Replace everything in `Code.gs` with the contents of `apps-script/Code.gs` from this repository (Ctrl+A, Ctrl+V), then save with Ctrl+S.
   - Nothing else in the project needs changing. The first line of the code (`@OnlyCurrentDoc`) limits the script to this one Sheet.
4. **Make the key.** In the VS Code terminal run `openssl rand -hex 32` and copy the 64 characters it prints. In Apps Script, open **Project Settings** (gear icon) → **Script Properties** → **Add script property**: Property `BRIDGE_KEY`, Value: paste. Click **Save script properties**. (Running the function `initBridge` once does the same with a key Google generates.)
5. **Same key in GitHub.** Open <https://github.com/kailash075/local-news-automation/settings/secrets/actions> → **New repository secret**: Name `SHEET_BRIDGE_KEY`, Secret: paste the same 64 characters → **Add secret**. Do not paste the key anywhere else.
6. **Deploy.** In Apps Script: **Deploy → New deployment** → click the gear next to "Select type" → **Web app**:
   - Execute as: **Me (erodeglitz@gmail.com)**.
   - Who has access: **Anyone**. The box starts at "Only myself", so change it. GitHub Actions cannot sign in to Google; the key from step 4 is what protects the bridge. Requests without the key get "unauthorized".
   - Click **Deploy**. Google asks to **Authorize access**: choose `erodeglitz@gmail.com`; on "Google hasn't verified this app" click **Advanced → Go to ErodeGlitz bridge (unsafe)** (it is your own script). The permission should be only for "the specific Google Sheets spreadsheets that this application is installed in"; if it asks for Gmail, Drive or all spreadsheets, cancel and check the first line of `Code.gs`. Then **Allow**.
   - Copy the **Web app URL** (it ends in `/exec`) into a second GitHub secret named `SHEET_BRIDGE_URL`, the same way as step 5.
7. **Create the tabs.** Run **Actions → migrate**. The summary should list the created tabs and end with "Self test: all values came back unchanged." If the self test fails, do not run anything else; the summary shows which values Sheets changed.
8. **After any change to `apps-script/Code.gs`.** Paste the new code, then **Deploy → Manage deployments → Edit (pencil) → Version: New version → Deploy**. Editing the existing deployment keeps the same URL. A new deployment would get a new URL.

Working with the Sheet:

- Read it any time; it is the newsroom's record: stories, source items, drafts, decisions, publications, job runs and errors, one tab each.
- You may add columns of your own (for notes) and use filter views. Do not rename or delete tabs or columns, and do not sort or delete rows: the jobs find rows by their content, but a sort or delete while a job is writing can misplace that write.
- Editing a cell by hand bypasses the checks the bridge enforces (for example, decisions and evidence are append-only through the bridge). Fix mistakes by hand only when you must, and say so in the review issue.
- The `settings` tab holds two switches: `collecting_enabled` (set by **Actions → collect-switch**) and `kill_switch` (set by `/killswitch`). Change them that way, not by hand. A hand-typed value that is not exactly `true` or `false` counts as the safe state: collecting paused, kill switch on.
- Limits: a Sheet holds up to 10 million cells, which is many years at this volume. Each bridge call takes about 1–2 seconds, so jobs run longer than they would with a database; check job durations in the first week.
- **Backups:** Google keeps the Sheet's version history (**File → Version history**). Once a week, also download a copy (**File → Download → Microsoft Excel**) and keep it offline. An automatic backup job is not written yet.

## 5. Cloudinary for card images (Phase 1) [Approval]

Instagram downloads each image from a public URL. Coimbatore 360 uses Cloudinary for this, and so does ErodeGlitz. Done on 2026-10-30; no card has been uploaded yet.

1. Sign up at <https://cloudinary.com> with `erodeglitz@gmail.com` on the **Free** plan. Do not add a card. Check the current Free plan limits on the pricing page; at about 6 cards a day of roughly 300 KB each, ErodeGlitz uses a few hundred MB a year.
2. From the dashboard, copy:
   - the **cloud name** into the secret `CLOUDINARY_CLOUD_NAME`;
   - the **API key** into the secret `CLOUDINARY_API_KEY`;
   - the **API secret** into the secret `CLOUDINARY_API_SECRET`.
3. Do not create an unsigned upload preset. The jobs sign every upload with the API secret, so nobody else can upload to the account.
4. Every rendered card, including cards of stories that are later rejected, is reachable by anyone who has its exact URL. The URL contains a SHA-256 of the card's template version and text, so it cannot be guessed without the exact card text. It appears in the review issue, which is public because the repository is public, and in the request to Instagram.

## 6. Meta and Instagram (Phase 2) [Approval]

Nothing in this section publishes anything. Publishing starts only after the go-live checklist in [Operations §11](OPERATIONS.md#11-release-and-change-management) and the owner's explicit approval of the first post.

### 6.1 Instagram account [Manual]

> Done 2026-10-30: the owner set `erodeglitz` to a **Creator** account and turned on two-factor authentication. Contact email: `erodeglitz@gmail.com`. Step 3 (bio) is still to do.

1. Make sure the `erodeglitz` Instagram account is a **professional account** (Business or Creator). To check, in the Instagram app go to your profile, tap ☰ (top right), then **Settings and activity**, then **For professionals**, then **Account type and tools**:
   - "Switch to professional account" is offered: the account is **Personal**. Switch it before Phase 2 (free, same menu). You make this change, not the software.
   - "Switch to creator account" is offered: it is **Business**.
   - "Switch to business account" is offered: it is **Creator**.
   - A **Professional dashboard** button on the profile also means Business or Creator. Labels vary a little between app versions.

   Business and Creator both work with the API, so there is no need to switch between them. When switching from Personal, Business with a news or media category suits a news page.
2. Turn on two-factor authentication and store the recovery codes offline.
3. Fill in the bio honestly: Erode local news in Tamil, sources credited, every post checked by an editor, and the corrections and complaints contact `erodeglitz@gmail.com`. Don't mention AI while captions are written by people. If Phase 3 (AI-assisted drafting) is switched on, add a line such as "AI-assisted drafts, edited by humans".

### 6.2 Meta app and business portfolio [Manual] [Approval]

> Done 2026-10-31 by the owner, with their own long-standing Facebook account (two-factor on): the app **ErodeGlitz Publisher** (App ID `1505546581400172`, type Business, Development mode) and the free business portfolio **ErodeGlitz**, which now holds the `erodeglitz` Instagram account. Still to do: app icon and privacy policy URL (step 7).

1. Sign in at <https://developers.facebook.com> with your own everyday Facebook account and register as a developer if you have not already. Facebook allows one account per person, so do not make a second account for this. Turn on two-factor authentication.
2. Create an app of type **Business**. Meta's get-started guide says an existing non-Business app cannot be used; create a new one.
3. Under **Instagram**, open **API setup with Unified login**. On 2026-10-31 the dashboard said: "API setup with Instagram login is not available for newer apps. Your app uses API setup with Unified login instead." Unified login needs a **business portfolio**: create a free one from the dashboard (name `ErodeGlitz`, business email `erodeglitz@gmail.com`) and connect the app to it.
4. Section 1, **Configure your app**: create the configuration. It is a Facebook Login for Business configuration with a **System-user access token** and expiration **Never**. Meta fixes its business assets ("Instagram account (required), Ad account (optional)"); only the permissions can be edited. Keep as few as Meta allows: on 2026-10-31 that was `instagram_basic`, `instagram_content_publish` and `instagram_manage_messages`, which Meta marks as required. The software never reads or sends messages.
5. Section 2, **Generate access tokens**: **Add account** gives `erodeglitz` the Instagram Tester role. Accept the invitation in Instagram (on the web: <https://www.instagram.com/accounts/manage_access/>, then **Tester invites**).
6. Add `erodeglitz` to the business portfolio: <https://business.facebook.com/settings>, then **Accounts**, then **Instagram accounts**, then **Add**, and log in as `erodeglitz`. On a phone browser this failed on 2026-10-31 with "The provided code is invalid for Instagram OpenID Connect"; on a computer it worked.
7. Fill in App Settings: app name, contact email (`erodeglitz@gmail.com`), app icon and **privacy policy URL**. Meta's App Review page lists the privacy policy URL as an App Settings field. On 2026-10-30, while this repository was private, the owner chose to host the page with GitHub Pages from a new public repository, for example `kailash075/erodeglitz-site`. Now that this repository is public, GitHub Pages can also publish from it; the owner chooses. Creating a repository or turning on Pages needs the owner's approval.
8. **Do not** request Advanced Access or submit App Review. Meta's App Review table says App Review is not required when the app is "only for a business I own or manage".
9. App mode (development or live): the app is in development mode. The Instagram pages checked did not say whether publishing to your own account works in development mode. Switch to live mode only if it is required and after the privacy policy page exists. [Approval]

### 6.3 Token [Manual] [Approval]

> Done 2026-10-31: a token for the system user `erodeglitz-publisher`, stored as the temporary secret `IG_BOOTSTRAP_TOKEN`. `TOKEN_ENCRYPTION_KEY` was created on 2026-11-01. Still to do: the import (step 6).

Meta's Unified login guide says to click **Generate token** in section 2 of the dashboard and copy the token: "It's shown only once." On 2026-10-31 that flow ended with "ErodeGlitz has been connected to ErodeGlitz Publisher" but showed no token, in Firefox or in Chrome. Its asset step also offered only "Create a new ad account", so it created an empty ad account named ErodeGlitz (approved by the owner). It has no payment method, so nothing can be charged; the software does not use it, and it can be closed in Business settings. The token was made in Business settings instead:

1. <https://business.facebook.com/settings>, then **Users**, then **System users**, then **Add**: name `erodeglitz-publisher`, role **Employee** (not Admin). A system user is a login for software inside the business portfolio, not a Facebook account.
2. Give it access (**Assign assets**, or **⋯** then **Assign assets** once it has one):
   - **Instagram accounts**: `erodeglitz`, partial access **Content** only;
   - **Apps**: ErodeGlitz Publisher, **Develop app**. Without an app role, **Generate token** says "No permissions available".
3. **Generate token**: app ErodeGlitz Publisher, expiry **Never**, permissions `instagram_basic` and `instagram_content_publish` only. Meta shows the token once: click **Copy**, and take no screenshot.
4. Do not paste the token into chat, issues, `.env` files or commit messages. Store it directly as a temporary GitHub secret: on GitHub, **Settings**, then **Secrets and variables**, then **Actions**, then **New repository secret**, name `IG_BOOTSTRAP_TOKEN`, paste the token, **Add secret**. Or from a terminal:

   ```bash
   gh secret set IG_BOOTSTRAP_TOKEN --repo kailash075/local-news-automation
   ```

5. Once only: create the secret `TOKEN_ENCRYPTION_KEY` as described in §3.3. Nobody sees its value, and no copy is needed.
6. Run the import: **Actions**, then **import-token**, then **Run workflow**. Only `OWNER_GITHUB_LOGIN` can import. The job checks the token with read-only calls, first the Unified login way (`graph.facebook.com`: `GET /me/assigned_instagram_accounts?fields=id,username`, which must list `erodeglitz`, then the account's `content_publishing_limit`) and, if Meta refuses it there, the older Instagram login way (`graph.instagram.com`: `GET /me?fields=user_id,username`). It then encrypts the token, stores it in the bridge's Script properties (never in a Sheet tab) and reads it back. The summary must say "import-token: token stored for @erodeglitz". If it says "nothing stored", it gives the reason; fix that and run it again. Nothing is posted.
7. Delete the temporary secret: **Settings**, then **Secrets and variables**, then **Actions**, then the delete button next to `IG_BOOTSTRAP_TOKEN`. Or:

   ```bash
   gh secret delete IG_BOOTSTRAP_TOKEN --repo kailash075/local-news-automation
   ```

8. Lifetime: a system-user token made with expiry **Never** does not expire. Each week `token-refresh.yml`, and each day **status**, check read-only that Meta still accepts it, and fail (GitHub e-mails you) if not. It stops working if someone clicks **Revoke tokens** on the system user, if the system user loses the Instagram account or the app, if the system user is deleted, or if the app is removed from the business portfolio. Then repeat steps 3, 4, 6 and 7. (A token from the older Instagram login, which new apps no longer get, lasts 60 days; `token-refresh.yml` renews it weekly with `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token`, which needs a token at least 24 hours old and unexpired.)

### 6.4 Read-only verification [Manual]

Run **Actions**, then **status**, then **Run workflow**. Its summary shows the token ("does not expire" for a system-user token) and Instagram's live publishing quota (`GET /<account ID>/content_publishing_limit`, read-only). Meta's pages give conflicting numbers (50 and 100 posts per 24 hours); the live value is the one that counts. The import already checked which account the token reaches, and the account ID is stored with the token, so there is no `IG_USER_ID` variable to set.

No container is created and nothing is published by this check.

## 7. Anthropic (Phase 3, optional) [Approval]

1. Create a Claude Console account and an organisation, and add billing. This spends money, so it needs explicit approval with a monthly budget.
2. Create a workspace named `erodeglitz` and set a **workspace spend limit** equal to the approved budget. This is the final backstop.
3. Create an API key in that workspace, then `gh secret set ANTHROPIC_API_KEY`.
4. Set the variables `LLM_ENABLED=true`, `LLM_MONTHLY_BUDGET_USD=<approved amount>` and `LLM_MODEL` (default `claude-opus-5-5` until the evaluation suggests otherwise). The code enforces its own cap below the Console limit.

## 8. Verification checklist

### Phase 0

- [ ] `pnpm install --frozen-lockfile`, typecheck, lint and test pass locally on Node 26 (passed on Node 22.23.2, 2026-10-30)
- [ ] CI passes on GitHub
- [x] Sample Tamil graphics approved by the owner (2026-10-30)
- [ ] Runner spike durations recorded in OPERATIONS.md

### Phase 1

- [ ] Google Sheet and Apps Script bridge set up; **Actions → migrate** self test passes
- [ ] Cloudinary account created after approval
- [ ] Secrets and variables set; no `LIVE` file
- [ ] First sources reviewed and approved in the registry
- [ ] Scheduled pipeline creates review issues; commands work from the GitHub mobile app
- [ ] Dry-run publisher records "would publish" decisions
- [ ] The Sheet downloaded once as `.xlsx` and the copy opens

### Phase 2

- [x] Meta app and token created by the owner after approval (2026-10-31)
- [ ] Token imported; temporary secret deleted
- [ ] **Actions → status** shows the token for `erodeglitz` and the live quota
- [ ] Go-live checklist completed ([Operations §11](OPERATIONS.md#11-release-and-change-management))
- [ ] **Go live** (Coimbatore 360's step 8): an (empty) `LIVE` file added to the repository root, then **Actions → collect-switch** → `start`
- [ ] First post explicitly approved by the owner

## 9. Not set up (as of 2026-11-01)

- Two-factor authentication on the `erodeglitz@gmail.com` Google account is not confirmed yet.
- The Instagram token is not imported yet (§6.3, step 6), so the temporary secret `IG_BOOTSTRAP_TOKEN` still exists.
- The Meta app has no icon and no privacy policy URL yet (§6.2, step 7).
- No `LIVE` file: the page is not live.
- No Anthropic account or API key.
- No editor-tip issue template.
- No privacy policy page or `erodeglitz-site` repository.
- The global active `gh` account is still `kailashrajendiran`; this repository uses local settings for `kailash075` instead (§2).
