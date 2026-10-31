# Workflows: the Coimbatore 360 pattern, Erode version

> **Status, 2026-10-31:** the Google Sheet, the Apps Script bridge and Cloudinary are set up, five newspapers are approved, and manual `collect` and `draft` runs have opened review issues. Not live: there is no `LIVE` file, automatic collecting is paused, and nothing can post, because the Meta app and the Instagram token do not exist yet (Phase 2).

ErodeGlitz posts to the owner's existing Instagram account **@erodeglitz** (Creator account). No new Instagram account is created.

## 1. The reference

The owner pointed to [news360-tn/coimbatore360-autopost](https://github.com/news360-tn/coimbatore360-autopost), the automation behind the Instagram page கோயம்புத்தூர் 360. It was inspected on 2026-10-30 at commit `a0d6c33`, as reference only. That repository has no licence, so no code was copied. ErodeGlitz reimplements the parts of the pattern that fit its own rules, in TypeScript.

How Coimbatore 360 works, in short:

```text
research_free.yml  every 2 h   search newspaper sites and Google/Bing News, keep today's Coimbatore news, queue by priority
write_stories.yml  every 20 min  free AI models rewrite each article in Tamil; one AI-generated "photo" per story
post.yml           every 5 min   build a reel (AI picture, cards, synthetic Tamil voice) and post it automatically
insights.yml       daily        Instagram insights become topic weights for the writer
collect-switch     manual       pause or start collecting
```

State lives in a Google Sheet behind an Apps Script web app, plus queue and log files that the bot commits to the repository.

## 2. What ErodeGlitz adopts

| Coimbatore 360 idea | ErodeGlitz version |
|---|---|
| Separate workflows for collect, write and post, each with its own concurrency group | `collect.yml`, `draft.yml`, `publish.yml`, each with its own concurrency group |
| The collector starts the writer when there is news, instead of waiting for the next schedule | `collect.yml` starts `draft.yml` only when new items arrived |
| Watchdog, because GitHub sometimes skips scheduled runs | `draft.yml` keeps a 4-hourly safety-net schedule; every job can be rerun safely |
| A cheap check job before the expensive one (`post.yml`) | A scheduled `draft.yml` run checks first and starts the Chromium job only when there is work. The check also expires old stories itself, so expiry never starts Chromium. Runs started by `collect` or `review-command` skip the check, because they always have work. |
| One-click pause and start (`collect-switch`, `LIVE` file, `PAUSED` variable) | The same three switches, used the same way. See §4. |
| Manual runs of the poster are test-only by default (`dry_run`) | `publish.yml` and `collect.yml` manual runs are dry runs unless you untick the box |
| "Setup not finished" exit when secrets are missing | Every job checks its configuration and exits cleanly with a clear message |
| Priority: power cut > crime > accident > civic > the rest | Topic priority with power cuts first (`src/pipeline/topic.ts`). Crime and accidents are flagged sensitive, so an editor decides. |
| Only today's news; finished power cuts and passed dates are skipped | Stale and expired stories are never drafted or published (`src/pipeline/freshness.ts`). Stories not approved within 48 hours, and notices whose day is over, expire and their review issues close (`src/review/expiry.ts`); the publisher checks the notice date again before posting. |
| Neighbour districts are rejected even when close; a story naming both a Coimbatore place and a neighbour is kept | Same rule with an Erode gazetteer and a neighbour list (Tiruppur, Coimbatore, Salem, Namakkal, Karur, Nilgiris, Chamarajanagar) |
| Same event from two outlets is posted once | MinHash near-duplicate clustering, plus a check against everything published in the last 7 days |
| Reads Instagram's live `content_publishing_limit` before posting | Same, and our own cap is far lower (6 a day) |
| Weekly refresh of the 60-day Instagram token | `token-refresh.yml`, token stored encrypted in the bridge's Script properties |
| `ig_probe.yml` health check | `status.yml`, read-only, daily |
| Google Sheet as the working store, reached through an Apps Script web app with a key | Same idea: one tab per table in the `ErodeGlitz Newsroom` Sheet, reached only through `apps-script/Code.gs` (written for ErodeGlitz). The key travels in the request body, not the URL; writes hold the script lock; decisions, evidence and errors are append-only. Owner decision, 2026-10-30. |
| Images on Cloudinary, so Instagram can download them | Same, with signed uploads (no unsigned preset) |
| Regression tests named after real incidents, run on every push | `ci.yml` runs typecheck, lint and Vitest on every push |
| Finished media kept so a retry does not rebuild | Rendered cards are content-addressed on Cloudinary (named by a SHA-256 of the card's template version and text); a rerun reuses them |
| Official Instagram API (`graph.instagram.com`, `media` then `media_publish`) | Same API, same login type |

## 3. What ErodeGlitz deliberately does differently

| Coimbatore 360 | ErodeGlitz | Why |
|---|---|---|
| Every story posts automatically, including crime | Every post is approved by an editor on its GitHub issue. Sensitive stories need `/approve-sensitive`. | Owner's rule: human approval for sensitive, disputed or insufficiently verified stories. Phase 4 may allow auto-posting only for allowlisted official notices, such as power cuts, with a veto window. |
| One photorealistic AI-generated image per story, and its config has `ai_label: false` | Text-only Tamil cards. No AI images, no publisher photos. | A realistic picture of an event that was never photographed misleads readers. AI images of news are against the editorial policy (§9). |
| Free AI models rewrite the newspaper article | Phase 1 captions are editor-written or template-based (power-cut notices). AI drafting is a Phase 3 decision. | Publisher text may not be sent to AI unless its terms allow it. Dinamalar's robots.txt signals against AI use. AI never counts as verification. |
| Reads newspaper district pages and searches Google/Bing News with a Chrome browser User-Agent | The same newspapers' Erode pages (Dinamalar, Dinamani, Dinakaran, Polimer, Hindu Tamil), approved by the owner on 2026-10-30. No Google or Bing News: Google's robots.txt disallows its RSS search and Bing's feed allows only personal, non-commercial use. robots.txt obeyed; the bot names itself (`ErodeGlitzBot/0.1`) | Permitted sources only (safety invariant 9) |
| An AI "fact gate" re-reads the article | Verification levels come from evidence only: an official source, two independent sources, or an editor's `/attest` | AI output never counts as verification |
| Up to 50 reels a day, posted the moment they are made | At most 6 posts a day, 08:00 to 21:00 IST, at least 30 minutes apart | Owner decision (cadence) and spam-risk control (risk R11) |
| Reels with a synthetic Tamil voice | Single-image posts (1080×1350) | Reels and video are non-goals for now. They can be a later phase if the owner wants them; a voice service would need its own terms review. |
| Queue files and logs committed to git by the bot | Everything is in the Sheet; the bot never commits | No runner or git state; the repository only changes through reviewed commits |
| Public repository | Private repository | Review issues contain unpublished, possibly unverified material |
| Story submission by e-mail to a bridge Gmail | Tips arrive as GitHub issues from a template and need the same verification | No inbound e-mail parsing; one audit trail |

## 4. Switches

The same switches as Coimbatore 360, used the same way (owner decision, 2026-10-31):

| Switch | Effect | Default |
|---|---|---|
| **Actions → collect-switch** → `pause` / `start` | Automatic collecting and drafting on or off. Scheduled `collect` and `draft` runs check it; a run started by hand or by another workflow always works. Posting continues. Only the owner can start it. | paused |
| `LIVE` file in the repository root | Posts reach Instagram only while it exists. Remove it to stop posting. | no file (not live) |
| Manual run of **publish** | Test only by default (`dry_run`) | dry run |
| Repository variable `PAUSED` = `true` | Full stop of posting too | not set |

Three small differences. Coimbatore 360's collect-switch commits a `research_free/ENABLED` file; ErodeGlitz keeps the switch in the Sheet (`collecting_enabled` in the `settings` tab), because the bot never commits. In Coimbatore 360 a manual post run with `dry_run` unticked posts even without the `LIVE` file; here nothing posts without it. And Coimbatore 360's code never reads `PAUSED`; here it works.

ErodeGlitz adds two safeguards, because the owner's rules require them:

| Safeguard | Effect |
|---|---|
| `/approve <rev>` (or `/approve-sensitive <rev>`) on the story's issue | Every post needs it, live or not |
| `/killswitch on <reason>` on any issue | Stops all posting at once, from a phone too. Only the owner can undo it with `/killswitch off`. The publisher also turns it on by itself after account or token errors. Stored as `kill_switch` in the Sheet. |

`PUBLISH_ON_APPROVAL` = `true` (repository variable) makes an approval start `publish` at once, only while live; otherwise the 2-hourly run picks it up.

**Go live** (Coimbatore 360's step 8): add an (empty) `LIVE` file to the repository root, then **Actions → collect-switch** → `start`. Approved stories then post with the next `publish` run.

## 5. Schedules and cost

All times IST (`timezone: "Asia/Kolkata"` on each cron entry). The minutes are estimates for the code as of 2026-10-31 (see the measurements below the table); recheck them against real runs in the first week after collecting starts.

| Workflow | When | Runner | Runs a month | Minutes a month (est.) |
|---|---|---|---|---|
| `collect.yml` | 06:07 to 22:07, every 2 h | `ubuntu-slim` | about 270 | about 300 |
| `draft.yml`, check job | safety net only: 07:37 to 19:37, every 4 h | `ubuntu-slim` | about 120 | about 120 |
| `draft.yml`, render job | after `collect` when something is new, after `/caption` or `/headline`, and when the safety-net check finds work | `ubuntu-latest` (Chromium) | about 400 | about 500 |
| `review-command.yml` | each editor command | `ubuntu-slim` | about 600 | about 600 |
| `publish.yml` | after an approval; catch-up 08:47 to 20:47, every 2 h | `ubuntu-slim` | about 390 | about 390 |
| `status.yml` | daily 07:13 | `ubuntu-slim` | 30 | 30 |
| `token-refresh.yml` | Mondays 03:17 | `ubuntu-slim` | 4 | 4 |
| `ci.yml` | each push | `ubuntu-latest` | depends | about 100 |

GitHub rounds each job up to a whole minute, so even a job that exits at once costs one minute. A job skipped by its `if:` condition costs nothing.

Like Coimbatore 360, scheduled runs start every time and check their switch inside the job. While collecting is paused and the page is not live, each scheduled run still costs about one minute: `collect` 270, `draft` check 120, `publish` 210, `status` 30 and `token-refresh` 4, so about 630 minutes a month (about USD 1.30 at the `ubuntu-slim` rate below). Setting `PAUSED` = `true` skips the `publish` job entirely.

Rough monthly cost against the USD 12 included on GitHub Free, once collecting is started: `ubuntu-slim` about 1,450 minutes × USD 0.002 ≈ USD 2.90; `ubuntu-latest` about 600 minutes × USD 0.006 ≈ USD 3.60; total about USD 6.50. That is a little above the 50% target in the [operations runbook](OPERATIONS.md#9-cost-monitoring-and-budgets). If Chromium works on `ubuntu-slim` (Phase 0 runner spike), the render job moves there and the total drops to about USD 4.

What keeps a job near one minute (changed 2026-10-31):

- **Setup takes seconds.** Jobs use the Node.js that is already on the runner (`.node-version` is 24, the version on `ubuntu-slim`), and restore their three production packages from the Actions cache. pnpm only runs when `pnpm-lock.yaml` changes, and in `ci.yml`.
- **The Sheet is read and written in bulk.** Each bridge call takes 1–2 seconds, so the jobs no longer make calls per story: the draft check makes 5, a draft run with nothing new 6 and triage 7, whether 2 or 100 stories are open, and `collect` makes one fetch-state read plus one item write per source. `test/sheet-requests.test.ts` pins these numbers.
- **`collect` fetches the five newspapers at the same time,** still one request at a time per site.

Measured before that change (2026-10-30 and 31): setup 25–67 s per job; the first real `collect` 5.5 min (49 new items); draft checks 2.5–3 min and draft runs 3–5 min on the first day, growing with every open story. At that rate a month would have cost roughly USD 15, more than the free allowance.

## 6. What the owner does each day (once live)

1. Open the GitHub app → this repository → **Issues**. Each new story has one issue with the card preview, sources and checks. A draft run opens at most 10 new issues, power cuts and the newest first; the rest follow in the next run. Until you write a caption, an issue's title is the newspaper's headline; then it becomes your headline. After an update to the issue layout, run **Actions → draft** with **refresh issues** ticked to rewrite all open issues.
2. Approve with `/approve <rev>` (or `/approve-sensitive <rev>`), fix with `/caption …`, or `/reject <reason>`.
3. Check **Actions → status** once a day.
4. If something goes wrong, `/killswitch on <reason>` on any issue.

## 7. Before any of this runs

| Step | Who | Needs approval |
|---|---|---|
| Push the code to GitHub (`ci.yml` starts on push) | Owner approves; Claude pushes as `kailash075` | Yes |
| Create the `ErodeGlitz Newsroom` Sheet and deploy the Apps Script bridge ([setup guide §4](SETUP_GUIDE.md#4-google-sheet-and-apps-script-bridge-phase-1-approval)) | Owner | Yes |
| Create the Cloudinary account ([setup guide §5](SETUP_GUIDE.md#5-cloudinary-for-card-images-phase-1-approval)) | Owner | Yes |
| Add secrets `SHEET_BRIDGE_URL`, `SHEET_BRIDGE_KEY`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `TOKEN_ENCRYPTION_KEY`, and the repository variables | Owner | Yes |
| Run **Actions → migrate** | Owner | Yes |
| Review and approve the first sources' terms | Owner | Yes |
| Phase 1 trial for 14 days: **Actions → collect-switch** → `start`, without a `LIVE` file, so review issues arrive and nothing posts | Owner | Yes (Actions minutes) |
| Meta app, Instagram token for @erodeglitz, privacy-policy page, lawyer review | Owner | Yes (Phase 2) |
| **Go live**: add an (empty) `LIVE` file to the repository root, then **Actions → collect-switch** → `start` | Owner | Yes |
| First real post: `/approve` on its issue | Owner | Yes |
