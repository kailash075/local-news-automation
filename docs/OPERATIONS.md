# Operations

> **Status: planned runbook, 2026-10-29.** None of these jobs, commands or alerts exist yet. Commands such as `pnpm run job:reconcile` are the planned interface; their phase is noted where it matters.
> All times are IST (Asia/Kolkata). GitHub cron entries set `timezone: "Asia/Kolkata"`; without it, GitHub uses UTC.
> `gh` commands here must run as `kailash075`. On the owner's PC the global `gh` account is different, so prefix them with `GH_TOKEN="$(gh auth token --user kailash075)"` (see [setup guide §2](SETUP_GUIDE.md#2-local-development)).

## 1. Operating model

| Role | Who | Responsibilities |
|---|---|---|
| Owner | `kailash075` | Approves accounts, spending and go-live; only person who can switch the kill switch off; handles incidents, complaints and legal questions |
| Editor(s) | Logins in `EDITOR_GITHUB_LOGINS` (currently only `kailash075`) | Review stories, write or edit captions, verify, approve or reject; can switch the kill switch on |
| The system | GitHub Actions jobs | Collect, process, draft, render, open review issues, publish approved items, alert |

Editors work from the GitHub mobile app or the website: review issues, then comment commands.

## 2. Schedules

| Workflow | Schedule (IST) | Cron (with `timezone: "Asia/Kolkata"`) | Notes |
|---|---|---|---|
| `pipeline.yml` | Hourly at :23, from 06:23 to 22:23 | `23 6-22 * * *` | 17 runs a day. Off-the-hour minute, because GitHub delays scheduled runs at high load, especially at the start of each hour. |
| `publish.yml` | On demand | none | Started by `review-command.yml` after an approval, or by the owner. `pipeline.yml` also publishes due items at the end of each run. |
| `review-command.yml` | On each issue comment starting with `/` | none | Non-command comments are filtered out by a job-level `if`, so no runner starts. |
| `maintenance.yml` | Daily 02:37; backup export on Sundays | `37 2 * * *` | Retention, health checks, daily digest |
| `token-refresh.yml` | Mondays 03:41 | `41 3 * * 1` | Phase 2 onwards |
| `ci.yml` | Push and pull request | none | |

Scheduled runs can be late or, under heavy load, dropped. The design tolerates this because every job catches up on whatever is due. If no pipeline run has succeeded for 6 hours, an alert is raised (§5).

Measured durations (filled in during Phase 0 and Phase 1):

| Job | `ubuntu-slim` | `ubuntu-latest` | Date measured |
|---|---|---|---|
| pipeline (no drafts) | — | — | — |
| pipeline (with render) | — | — | — |
| publish | — | — | — |
| ci | — | — | — |

## 3. Daily routine for editors

1. Open the GitHub issues labelled `review`, sorted by risk (`risk:R2` first) and age.
2. For each story: read the sources, check the verification level, read the caption and graphic, and work through the checklist in the [editorial policy](EDITORIAL_POLICY.md#14-reviewer-checklist).
3. Act with commands: `/caption`, `/attest`, `/approve <rev>`, `/approve-sensitive <rev>`, `/schedule <rev> <HH:MM>`, `/hold`, `/reject`.
4. Check the daily digest issue for failures, alerts and the publishing log.

Targets: R0 notices reviewed within 2 hours during the posting window, so the information is still useful; everything else on the same day.

Expiry (`src/review/expiry.ts`, checked by every `draft` run; while automatic collecting is paused, the scheduled runs stop, so nothing expires until the next run):

- A story not approved within **48 hours** expires: the bot writes a short note on its issue and closes it as "not planned". Each editor command on the story (for example `/caption` or `/hold`) starts the 48 hours again.
- A notice (power cut, water supply, traffic, weather, jobs) expires as soon as its stated day is over. It cannot be approved, captioned or posted after that, and the publisher checks the date again just before posting.
- To bring back an expired story that is still news, comment a new `/caption` on its closed issue. The issue reopens and the story is back in review with another 48 hours. This does not work for a notice whose day is over.

## 4. Kill switch

### Stop publishing (takes under a minute)

Use **any one** of these. Each is enough on its own.

1. **From a phone:** comment `/killswitch on <reason>` on any issue. Any editor can do this. It turns on the Sheet's `kill_switch` (`settings` tab), which the publisher reads immediately before each Instagram call.
2. **Repository variable `PAUSED`** (Coimbatore 360's full stop): GitHub, then Settings, then Secrets and variables, then Actions, then Variables: create `PAUSED` with the value `true`. Or from a terminal:

   ```bash
   gh variable set PAUSED --body true --repo kailash075/local-news-automation
   ```

3. **Remove the `LIVE` file** (Coimbatore 360's way to stop posting): delete it on GitHub (open the file, then the bin icon, then commit), or `git rm LIVE`, commit and push.
4. **Disable the workflow:**

   ```bash
   gh workflow disable publish.yml --repo kailash075/local-news-automation
   ```

5. **Cancel a run in progress:** `gh run list --workflow publish.yml`, then `gh run cancel <run-id>`.
6. **Last resort:** remove the app's access to the Instagram account (Instagram settings, apps and websites), or revoke the token in the Meta app dashboard. Publishing then needs a new token (§8).

A post whose `media_publish` request had already been sent may still appear. Check the account, then follow runbook 6.A if needed.

### Automatic trips

The system turns the kill switch on by itself, and opens an `ops-alert` issue, when it sees:

- an authentication or token error;
- Instagram error 4 / 2207051 (flagged as spam) or 25 / 2207050 (account restricted);
- two unresolved `publish_unknown` publications;
- more posts today than `MAX_POSTS_PER_DAY` (should be impossible);
- a near-duplicate of a post published in the last 24 hours.

### Resume (owner only)

1. Understand and fix the cause. Write a short note in the incident issue.
2. Check the publish queue: approvals older than the TTL have expired, so re-approve anything that should still go out.
3. Check the live quota with `pnpm run job:ig-check` (Phase 2).
4. Comment `/killswitch off`. Only `OWNER_GITHUB_LOGIN` is accepted.
5. If you used them: delete the `PAUSED` variable, put the `LIVE` file back, and re-enable `publish.yml`.
6. Watch the next publish run.

## 5. Alerts

Alerts are GitHub issues labelled `ops-alert`, with one open issue per alert key; repeats are added as comments. GitHub notifies the owner by email and in the mobile app.

| Alert key | Trigger | First response |
|---|---|---|
| `kill-switch-tripped` | Automatic trip | §4, then the matching runbook in §6 |
| `token-expiring` | Under 14 days of validity left | Run `token-refresh.yml` by hand; if it fails, see §8 |
| `token-invalid` | Authentication error | Runbook 6.D |
| `publish-failed` | Permanent error, or retries used up | Read `publish_attempts`; fix; re-queue |
| `publish-unknown` | Ambiguous result | Runbook 6.C |
| `source-failing` | 6 consecutive failures for a source | Runbook 6.G |
| `quota-low` | Live publishing quota nearly used | Runbook 6.F |
| `pipeline-stale` | No successful pipeline run for 6 hours | Runbook 6.J |
| `review-backlog` | More than 10 stories waiting over 6 hours | Triage: reject or hold low-value items |
| `sheet-near-limit` | Sheet over 70% of 10 million cells, or Cloudinary over 70% of its Free plan | Runbook 6.I |
| `llm-budget` | Over 80% of the monthly LLM budget (Phase 3) | Runbook 6.K |
| `actions-budget` | GitHub's 90% usage email (arrives by email, not as an issue) | Runbook 6.J |

Limitation: if GitHub Actions itself stops running, no alert issue can be created. GitHub's own failure emails, and the absence of the daily digest, are the signals. An external free heartbeat service could be added later, but that is a new account and needs approval.

## 6. Incident runbooks

Open an issue labelled `incident` for every incident, and record the timeline and actions.

### 6.A Wrong or harmful post published

1. `/killswitch on wrong-post`.
2. Assess the harm:
   - **Serious** (identifies a protected person, defamatory, could incite, dangerous misinformation): delete the post in the Instagram app **now**.
   - **Material factual error:** edit the caption with a `திருத்தம்:` note; publish a correction post if the error was widely seen.
   - **Minor:** edit the caption.
3. Record the action with `/retract <reason>` or a correction note in the story's issue.
4. Answer any complaint (see the [editorial policy §11](EDITORIAL_POLICY.md#11-complaints-and-grievances)).
5. Within 48 hours: find out which gate or check failed, add a test or rule, and update the policy if needed.
6. Resume (§4).

### 6.B Duplicate post

1. The kill switch has probably tripped already. Confirm it.
2. Delete the later duplicate in the Instagram app.
3. Compare the two publications' idempotency keys and stories. Either a missed cluster merge (tune thresholds, add a test case) or an idempotency bug (fix it before resuming; this is serious).

### 6.C Publish state unknown

1. `pnpm run job:reconcile -- --publication <id>` (Phase 2) reads the container status:
   - `PUBLISHED`: it finds the media ID in recent media and marks the publication published.
   - `FINISHED`: not published; the publication goes back to the queue.
   - `EXPIRED` or `ERROR`: marked failed, for a human to decide.
2. Never start a fresh publish for that story until reconciliation finishes.
3. Two or more unknown states in a row: check Meta's status pages and keep the kill switch on until things are stable.

### 6.D Token expired or invalid

1. Publishing has stopped (automatic trip).
2. If the token can still be refreshed (less than 60 days old and not revoked), run `token-refresh.yml`.
3. Otherwise generate a new token in the Meta dashboard and import it ([setup guide §5.3](SETUP_GUIDE.md#63-token-manual-approval)).
4. Run `job:ig-check`, then resume (§4).

### 6.E Instagram restriction or spam flag (4 / 2207051, 25 / 2207050)

1. Publishing has stopped. **Do not retry.**
2. Open the Instagram app as the account owner and read any notice. Resolve or appeal through Instagram's own process.
3. Review recent posting frequency and content for anything that looks spammy (frequency, repeated text, hashtags).
4. Resume only after the restriction is lifted, at a lower cadence for a week.

### 6.F Publishing quota exhausted (9 / 2207042)

This should not happen with a cap of 6 posts a day. Stop, check `content_publishing_limit` and the publication log for an unexpected burst, and fix the cause before resuming. Items are rescheduled automatically after the rolling window.

### 6.G Source failing or terms changed

1. Check the site by hand. Has the URL or format changed? Is the site down? Did the terms or robots.txt change?
2. If the terms or robots.txt no longer permit our use, set the source's terms status to `rejected` in the registry. Never work around a block.
3. Update the adapter or URL through a pull request; review the terms again if the site changed significantly.

### 6.H Sheet or bridge unreachable

1. Jobs fail closed, so nothing publishes. The job summary shows the bridge's answer.
2. "unauthorized": `SHEET_BRIDGE_KEY` does not match the Script property `BRIDGE_KEY`. Copy it again ([setup guide §4](SETUP_GUIDE.md#4-google-sheet-and-apps-script-bridge-phase-1-approval), step 5).
3. "did not answer with JSON": the web app URL is wrong, or the deployment is not open to "Anyone". With "(HTTP 401)" it is the access setting: **Deploy → Manage deployments → Edit (pencil)**, set Who has access to **Anyone**, Version **New version**, **Deploy**; the URL stays the same. Otherwise check `SHEET_BRIDGE_URL`.
4. "busy" again and again: another request held the lock for 25 seconds. Look at the Apps Script **Executions** page for a stuck or slow call.
5. "the Sheet layout is … but this code expects …": run **Actions → migrate**.
6. If the Sheet itself was damaged: **File → Version history**, restore the last good version, then run **Actions → migrate**.

### 6.I Sheet or Cloudinary near the limit

Archive old rows of `job_runs`, `errors` and `publish_attempts` into a copy of the Sheet (a retention job is still to write); delete renders of rejected stories in Cloudinary. A paid plan costs money and needs the owner's approval.

### 6.J Actions not running, or budget used up

- Check the repository's Actions tab and GitHub's status page.
- GitHub disables scheduled workflows in **public** repositories after 60 days without repository activity. This repository is private, but if it ever becomes public, re-enable them in the Actions tab.
- If the included compute is used up, runs are blocked until the next billing cycle unless a payment method and budget allow more, which costs money and needs approval. Reduce frequency (for example, `pipeline.yml` every 2 hours) and move jobs to `ubuntu-slim`.
- If GitHub restricts the account or repository over its Actions terms (risk R1), see §13.

### 6.K LLM outage or budget used up (Phase 3)

Captions fall back to manual automatically. Nothing else is affected. Raising the budget needs the owner's approval.

### 6.L Secret leak suspected

1. `/killswitch on secret-leak`.
2. Rotate the affected secret at its source: the bridge key (delete `BRIDGE_KEY` in Script properties, run `initBridge`, update `SHEET_BRIDGE_KEY`), the Google account password, the Cloudinary API secret, the Instagram token (remove app access, generate a new one), the Anthropic key, or the encryption key (§8).
3. Update the GitHub secret; check the provider's logs for misuse.
4. If the secret was ever committed, treat it as public forever. Rotating it is the fix; rewriting git history is not enough.

## 7. Backups and restore

- **Always on:** Google keeps the Sheet's version history (**File → Version history → See version history**). A bad edit or a damaged tab can be rolled back from there.
- **Weekly** (owner, until an automatic job exists): **File → Download → Microsoft Excel (.xlsx)** and keep the file offline. The Instagram token is not in the Sheet, so the download holds no credentials.
- **Restore:** open the downloaded file, copy the tabs back into the `ErodeGlitz Newsroom` Sheet (or a new Sheet with the bridge set up again), then run **Actions → migrate** so the layout check and self test pass.
- **Quarterly:** open the latest download and check that every tab is there.
- Rendered images are not backed up; they can be regenerated from drafts.
- Keep an offline copy of `TOKEN_ENCRYPTION_KEY` in a password manager; without it the stored Instagram token cannot be read and a new token must be generated.
- An automatic export (`maintenance.yml`) is not written yet.

## 8. Token lifecycle

| Event | Action |
|---|---|
| Initial import | [Setup guide §5.3](SETUP_GUIDE.md#63-token-manual-approval) |
| Weekly | `token-refresh.yml` refreshes (the token must be at least 24 hours old and unexpired) and stores the new expiry |
| Under 14 days left | `token-expiring` alert |
| Expired, or refresh impossible | Generate a new token in the dashboard and re-import it |
| Suspected compromise | Remove app access in Instagram settings, generate and import a new token, check recent posts |
| Encryption key rotation (yearly) | Add the new key as the next `key_version`, re-encrypt, remove the old key |

## 9. Cost monitoring and budgets

### GitHub Actions (private repository)

GitHub Free includes **USD 12 per month** of Actions compute for private repositories. Linux 2-core runners cost USD 0.006 per minute and `ubuntu-slim` (1 vCPU) costs USD 0.002 per minute. Without a payment method, usage is **blocked** when the allowance runs out; GitHub emails at 90% and 100%.

Planning estimate, to be replaced with measurements. **Superseded:** the workflows now follow the Coimbatore 360 split (collect, draft, publish); the current estimate, about USD 6.70 a month, is in [Workflows §5](WORKFLOWS.md#5-schedules-and-cost). The table below is the original single-pipeline estimate. It assumes whole billed minutes per job (GitHub has historically rounded each job up to the next minute; confirm on the billing page).

| Workflow | Runs per month | Billed minutes per run | `ubuntu-slim` cost | `ubuntu-latest` cost |
|---|---|---|---|---|
| pipeline | 510 | 2 | USD 2.04 | USD 6.12 |
| review-command | 600 (about 20 commands a day) | 1 | USD 1.20 | USD 3.60 |
| publish | 180 (up to 6 posts a day) | 2 | USD 0.72 | USD 2.16 |
| maintenance | 30 | 2 | USD 0.12 | USD 0.36 |
| token-refresh | 4 | 1 | USD 0.01 | USD 0.02 |
| ci (on `ubuntu-latest`) | 60 | 3 | USD 1.08 | USD 1.08 |
| **Total** | | | **about USD 5.17 (43%)** | **about USD 13.34 (over budget)** |

Conclusion: the schedule above fits only if most jobs run on `ubuntu-slim`. If the Phase 0 spike shows they cannot, run `pipeline.yml` every 2 hours and publish only from the pipeline run (no separate dispatch) until measurements say otherwise.

### Google Sheet and Cloudinary

The Sheet holds up to 10 million cells; at this volume that is many years. Apps Script and Sheets are free for this use. Cloudinary's Free plan limits are on its pricing page; check its usage page monthly.

### Claude API (Phase 3, optional)

Rough estimate per draft: about 3,000 input and 1,500 output tokens (output includes thinking; Tamil text can use more tokens per word than English, so measure). Prices checked 2026-10-29, per million tokens:

| Model | Input / output price | Per draft | 600 drafts a month (20 a day) | With Batch API (50% off) |
|---|---|---|---|---|
| `claude-opus-5-5` (default) | USD 4 / 20 | about USD 0.042 | about USD 25 | about USD 13 |
| `claude-sonnet-5-5` | USD 2 / 10 | about USD 0.021 | about USD 13 | about USD 6 |
| `claude-haiku-5-5` | USD 0.10 / 0.50 | about USD 0.001 | under USD 1 | under USD 1 |

Prompt caching of the fixed system prompt lowers input cost further. Which model is used is the owner's decision after the Phase 3 evaluation compares Tamil quality. Controls: `LLM_MONTHLY_BUDGET_USD` enforced in code from `llm_usage`, a per-day item cap, at most 3 LLM revisions per story, and a Console workspace spend limit.

### Monthly cost review

- [ ] GitHub billing: Actions usage this cycle
- [ ] Sheet size (rows in `source_items`, `job_runs`, `errors`) and Cloudinary usage
- [ ] `llm_usage` total compared with the Console (Phase 3)
- [ ] Any new paid service? It must have the owner's written approval.

## 10. Data retention

| Data | Kept for | Then |
|---|---|---|
| Source item excerpts | 90 days | Excerpt removed; URL hash and MinHash kept 1 year for de-duplication |
| Discarded or rejected stories and their drafts | 90 days | Deleted; editorial decisions kept |
| Unpublished renders (Cloudinary) | 30 days | Deleted |
| Published renders (Cloudinary) | 1 year | Deleted (the post remains on Instagram) |
| Published drafts, publications, publish attempts, editorial decisions | At least 2 years | Review with counsel |
| `job_runs`, `errors` | 180 days | Deleted |
| `llm_usage` | 2 years | Deleted |
| Weekly `.xlsx` downloads of the Sheet | Owner keeps them offline | Delete copies older than 2 years |

A `legal_hold` flag on a story suspends deletion of everything related to it, for example after a complaint or legal notice.

The Sheet bridge never deletes rows, so until a retention job is written these periods are applied by hand: move old rows into an archive copy of the Sheet, then delete them from the working Sheet while no job is running.

## 11. Release and change management

- Every change goes through a pull request with green CI. Use branch protection if the plan supports it for private repositories.
- **Merging to `master` deploys.** Scheduled workflows run the latest commit on the default branch at their next trigger.
- **Risky changes** (publisher, gates, Sheet layout): set `PAUSED` = `true`, merge, run `publish.yml` by hand in dry-run mode, check the results, then delete `PAUSED`.
- **Sheet layout changes:** add columns only (never rename or remove), in `src/sheet/tables.ts`, then run the manual `migrate.yml` workflow. Jobs check the layout version and refuse to run on a mismatch. After a change to `apps-script/Code.gs`, deploy a new version of the existing web app ([setup guide §4](SETUP_GUIDE.md#4-google-sheet-and-apps-script-bridge-phase-1-approval), step 8).
- **Dependencies:** Dependabot pull requests are reviewed like any other change; lockfile only, never floating versions.

### Phase 2 go-live checklist (first real post)

- [ ] Phase 1 exit criteria met
- [ ] [Instagram compliance checklist](INSTAGRAM_COMPLIANCE.md#13-go-live-compliance-checklist-phase-2) complete
- [ ] Lawyer review completed
- [ ] Token imported and `job:ig-check` passes
- [ ] Kill switch tested: each layer blocks a dry-run publish
- [ ] Reconciliation tested with injected faults in tests
- [ ] Owner has picked the first story and explicitly approved publishing it
- [ ] Owner added the `LIVE` file and ran **Actions → collect-switch** → `start`
- [ ] First post checked on Instagram (text, graphic, credit); the permalink is recorded
- [ ] For two weeks, `PUBLISH_ON_APPROVAL` stays off: approved stories go out with the 2-hourly `publish` run or a manual run

## 12. Periodic reviews

| Frequency | What |
|---|---|
| Daily | Digest issue: collected, discarded, in review, approved, published, failures, alerts |
| Weekly | Sample duplicates and relevance misses; corrections log; rejected-to-approved ratio; token expiry; alerts closed |
| Monthly | Costs (§9); source terms reviews due within 30 days; retention ran; backup downloaded |
| Quarterly | Re-check Meta documentation and the Graph API version ([compliance §13](INSTAGRAM_COMPLIANCE.md#13-go-live-compliance-checklist-phase-2)); GitHub terms and plan limits; Cloudinary and Google Apps Script limits; legal changes; restore test; due key rotations |

## 13. Contingency: moving off GitHub Actions

Trigger: GitHub restricts or warns about this use of Actions (risk R1), or the owner decides to move.

Because every job is a plain `pnpm run job:<name>` command, a move means changing the scheduler, not the code:

| Option | Fit | Cost and approval |
|---|---|---|
| Google Cloud Run Jobs with Cloud Scheduler | Container including Chromium; managed cron | Free tier likely covers this volume, but a billing account with a card is required. Needs approval. |
| Small virtual machine with systemd timers | Full control | Usually paid, or "always free" offers that need card verification and ongoing maintenance. Needs approval. |
| Self-hosted GitHub runner | Keeps workflows | Does not settle R1: the terms' general "develop and test" clause covers all of Actions. Not recommended for that purpose. |

Steps:

1. Build a container image that runs the same commands.
2. Move the secrets to the new platform's secret manager.
3. Recreate the schedules.
4. Replace the issue-comment trigger: the new host polls GitHub issues for new commands every few minutes with a fine-grained token limited to issues on this repository.
5. Run in dry-run mode for 3 days, then switch publishing on and disable the GitHub schedules.
