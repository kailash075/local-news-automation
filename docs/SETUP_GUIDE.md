# Setup Guide

> **Status, 2026-10-30: nothing in this guide has been set up yet.** Each step is marked:
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

4. **Checks** (Phase 0 code exists since 2026-10-30):

   ```bash
   pnpm install
   pnpm run typecheck
   pnpm run lint
   pnpm test
   pnpm run render:samples   # writes sample Tamil cards to out/samples/
   ```

   Render tests need the Chromium headless shell: `pnpm exec playwright-core install chromium-headless-shell`.

5. **Local environment file.** Copy `.env.example` to `.env` for local experiments. `.env` is already git-ignored. Local runs default to `DRY_RUN=true` and `PUBLISHING_ENABLED=false`. Never put production credentials in `.env` unless you need them for a specific task, and remove them afterwards.

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
| `SHEET_BRIDGE_KEY` | 1 | The Script property `BRIDGE_KEY` (§4, step 5) |
| `CLOUDINARY_API_KEY` | 1 | Cloudinary dashboard (§5) |
| `CLOUDINARY_API_SECRET` | 1 | Cloudinary dashboard (§5) |
| `TOKEN_ENCRYPTION_KEY` | 1 | 32 random bytes, base64: `openssl rand -base64 32`. Keep an offline copy in your password manager; without it the stored Instagram token cannot be read. |
| `IG_BOOTSTRAP_TOKEN` | 2 | Temporary. Delete it right after the import workflow succeeds. (The import workflow is not written yet.) |
| `ANTHROPIC_API_KEY` | 3 | Only if Phase 3 is approved |

Repository **variables** (not secret). The names match what the workflows in `.github/workflows/` read; [Workflows §4](WORKFLOWS.md#4-switches) explains the switches.

| Name | Default when not set | Meaning |
|---|---|---|
| `COLLECTING_ENABLED` | off | Must be exactly `true` for scheduled `collect`, `draft` and `status` runs to start |
| `PUBLISHING_ENABLED` | off | Must be exactly `true` for any publishing to happen |
| `DRY_RUN` | on | Must be exactly `false` for a scheduled publish run to call Instagram |
| `PUBLISH_ON_APPROVAL` | off | When `true`, an approval starts `publish.yml` at once |
| `EDITOR_GITHUB_LOGINS` | none (nobody can run commands) | Comma-separated logins allowed to run review commands. Set to `kailash075`. |
| `OWNER_GITHUB_LOGIN` | none (nobody can switch publishing on) | The only login that can switch publishing on. Set to `kailash075`. |
| `CLOUDINARY_CLOUD_NAME` | | Cloudinary cloud name (§5) |
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

> Owner decision, 2026-10-30: use a Google Sheet as storage, the same way Coimbatore 360 does. It replaces the Supabase plan. Nothing has been created yet.

The jobs never touch the Sheet directly. A small Apps Script web app inside the Sheet (the "bridge", `apps-script/Code.gs`) receives their requests, checks a key, and reads or writes rows while holding a lock, so two jobs cannot overwrite each other.

1. **Google account.** Sign in to Google as `erodeglitz@gmail.com`. Turn on two-factor authentication for this account first: the Sheet holds every editorial decision, and the bridge holds the encrypted Instagram token.
2. **Sheet.** Create a blank Google Sheet named `ErodeGlitz Newsroom`. Do not share it with anyone. Leave it empty; the migrate workflow creates the tabs.
3. **Bridge code.** In the Sheet, open **Extensions → Apps Script**. Name the project `ErodeGlitz bridge`.
   - Replace everything in `Code.gs` with the contents of `apps-script/Code.gs` from this repository.
   - Open **Project Settings** (gear icon), tick **Show "appsscript.json" manifest file in editor**, then replace `appsscript.json` with `apps-script/appsscript.json`. It limits the script to this one Sheet (`spreadsheets.currentonly`).
   - Save.
4. **Create the key.** In the editor, choose the function `initBridge` and click **Run**. Google asks for permission:
   - It should ask only to "see, edit, create and delete only the specific Google Sheets document that this application is connected to". If it asks for more, stop and check that the manifest from step 3 was saved.
   - Google shows "Google hasn't verified this app" because the script is yours, not a published app. Click **Advanced**, then **Go to ErodeGlitz bridge**.
5. **Copy the key.** **Project Settings → Script Properties** now shows `BRIDGE_KEY`. Copy its value into the GitHub secret: `gh secret set SHEET_BRIDGE_KEY`. Do not paste it anywhere else.
6. **Deploy.** **Deploy → New deployment**, type **Web app**:
   - Execute as: **Me (erodeglitz@gmail.com)**.
   - Who has access: **Anyone**. GitHub Actions cannot sign in to Google; the key from step 5 is what protects the bridge. Requests without the key get "unauthorized".
   - Click **Deploy** and copy the **Web app URL** (it ends in `/exec`): `gh secret set SHEET_BRIDGE_URL`.
7. **Create the tabs.** Run **Actions → migrate**. The summary should list the created tabs and end with "Self test: all values came back unchanged." If the self test fails, do not run anything else; the summary shows which values Sheets changed.
8. **After any change to `apps-script/Code.gs`.** Paste the new code, then **Deploy → Manage deployments → Edit (pencil) → Version: New version → Deploy**. Editing the existing deployment keeps the same URL. A new deployment would get a new URL.

Working with the Sheet:

- Read it any time; it is the newsroom's record: stories, source items, drafts, decisions, publications, job runs and errors, one tab each.
- You may add columns of your own (for notes) and use filter views. Do not rename or delete tabs or columns, and do not sort or delete rows: the jobs find rows by their content, but a sort or delete while a job is writing can misplace that write.
- Editing a cell by hand bypasses the checks the bridge enforces (for example, decisions and evidence are append-only through the bridge). Fix mistakes by hand only when you must, and say so in the review issue.
- The `settings` tab holds the switches. A hand-typed value turns publishing on only if it is exactly `true` in a plain-text cell; anything else counts as off.
- Limits: a Sheet holds up to 10 million cells, which is many years at this volume. Each bridge call takes about 1–2 seconds, so jobs run longer than they would with a database; check job durations in the first week.
- **Backups:** Google keeps the Sheet's version history (**File → Version history**). Once a week, also download a copy (**File → Download → Microsoft Excel**) and keep it offline. An automatic backup job is not written yet.

## 5. Cloudinary for card images (Phase 1) [Approval]

Instagram downloads each image from a public URL. Coimbatore 360 uses Cloudinary for this, and so does ErodeGlitz. Nothing has been created yet.

1. Sign up at <https://cloudinary.com> with `erodeglitz@gmail.com` on the **Free** plan. Do not add a card. Check the current Free plan limits on the pricing page; at about 6 cards a day of roughly 300 KB each, ErodeGlitz uses a few hundred MB a year.
2. From the dashboard, copy:
   - the **cloud name** into the variable `CLOUDINARY_CLOUD_NAME`;
   - the **API key** into the secret `CLOUDINARY_API_KEY`;
   - the **API secret** into the secret `CLOUDINARY_API_SECRET`.
3. Do not create an unsigned upload preset. The jobs sign every upload with the API secret, so nobody else can upload to the account.
4. Every rendered card, including cards of stories that are later rejected, is reachable by anyone who has its exact URL. The URL contains the image's SHA-256, so it cannot be guessed, and it appears only in the private review issue and in the request to Instagram.

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

### 6.2 Meta app [Manual] [Approval]

1. Sign in at <https://developers.facebook.com> and register as a developer if you have not already. Turn on two-factor authentication for that account.
2. Create an app of type **Business**. Meta's get-started guide says an existing non-Business app cannot be used; create a new one.
3. Add the Instagram product and open **API setup with Instagram business login**.
4. Fill in App Settings: app name, contact email (`erodeglitz@gmail.com`), app icon and **privacy policy URL**. Meta's App Review page lists the privacy policy URL as an App Settings field. The page will be hosted with GitHub Pages from a new public repository, for example `kailash075/erodeglitz-site` (owner decision, 2026-10-30). GitHub Free cannot publish Pages from this private repository, and creating the new repository needs the owner's approval.
5. Permissions needed: `instagram_business_basic` and `instagram_business_content_publish`. **Do not** request Advanced Access or submit App Review. Meta's App Review table says App Review is not required when the app is "only for a business I own or manage".
6. App mode (development or live): the Instagram pages checked did not say whether publishing to your own account works in development mode. Record what the dashboard shows during setup, and switch to live mode only if it is required and after the privacy policy page exists. [Approval]

### 6.3 Token [Manual] [Approval]

1. In the app dashboard, under Instagram, then **API setup with Instagram business login**, click **Generate token** next to the ErodeGlitz account and log in to Instagram. Dashboard tokens are long-lived and valid for 60 days.
2. Do not paste the token into chat, issues, `.env` files or commit messages. Store it directly as a temporary GitHub secret:

   ```bash
   gh secret set IG_BOOTSTRAP_TOKEN --repo kailash075/local-news-automation
   ```

3. Run the **Import Instagram token** workflow (`import-token.yml`, added in Phase 2). It checks the token with a read-only call, encrypts it, stores it in the bridge's Script properties (never in a Sheet tab), and writes the token expiry date to the job summary.
4. Delete the temporary secret:

   ```bash
   gh secret delete IG_BOOTSTRAP_TOKEN --repo kailash075/local-news-automation
   ```

5. The weekly `token-refresh.yml` job calls `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token`. Meta requires the token to be at least 24 hours old, unexpired, and to carry `instagram_business_basic`. A token that is not refreshed within 60 days expires and cannot be refreshed; you would then generate a new one (steps 1 to 4).

### 6.4 Read-only verification [Manual]

Phase 2 adds `pnpm run job:ig-check`, which performs **read-only** calls:

- `GET /me?fields=user_id,username`: confirms the account. Put `user_id` in the `IG_USER_ID` variable.
- `GET /<IG_USER_ID>/content_publishing_limit`: shows the live quota. Meta's pages give conflicting numbers (50 and 100 posts per 24 hours); the live value is the one that counts.

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
- [ ] Sample Tamil graphics approved by the owner
- [ ] Runner spike durations recorded in OPERATIONS.md

### Phase 1

- [ ] Google Sheet and Apps Script bridge set up; **Actions → migrate** self test passes
- [ ] Cloudinary account created after approval
- [ ] Secrets and variables set; `PUBLISHING_ENABLED=false`, `DRY_RUN=true`
- [ ] First sources reviewed and approved in the registry
- [ ] Scheduled pipeline creates review issues; commands work from the GitHub mobile app
- [ ] Dry-run publisher records "would publish" decisions
- [ ] The Sheet downloaded once as `.xlsx` and the copy opens

### Phase 2

- [ ] Meta app and token created by the owner after approval
- [ ] Token imported; temporary secret deleted
- [ ] **Actions → status** shows the token for `erodeglitz` and the live quota
- [ ] Go-live checklist completed ([Operations §11](OPERATIONS.md#11-release-and-change-management))
- [ ] First post explicitly approved by the owner

## 9. Not set up (as of 2026-10-30)

- No `ErodeGlitz Newsroom` Sheet and no Apps Script bridge (approved, not created).
- No Cloudinary account (needs approval).
- Two-factor authentication on the `erodeglitz@gmail.com` Google account is not confirmed yet.
- No Meta developer app and no token. (The `erodeglitz` Instagram account itself is ready: a Creator account.)
- No Anthropic account or API key.
- No GitHub secrets, variables, labels or issue templates. The workflows exist locally but are not pushed.
- No privacy policy page or `erodeglitz-site` repository.
- The global active `gh` account is still `kailashrajendiran`; this repository uses local settings for `kailash075` instead (§2).
