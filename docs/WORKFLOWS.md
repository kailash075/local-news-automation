# Workflows: the Coimbatore 360 pattern, Erode version

> **Status, 2026-10-30:** the workflow files and the code they run are written and tested locally. Nothing has been pushed, nothing runs on GitHub yet, and nothing can post: the Google Sheet, the Apps Script bridge, Cloudinary, the Meta app and the Instagram token do not exist yet, and every switch is off.

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
| One-click pause and start (`collect-switch`, `LIVE` file, `PAUSED` variable) | `switch.yml` plus repository variables. See §4. |
| Manual runs of the poster are test-only by default (`dry_run`) | `publish.yml` and `collect.yml` manual runs are dry runs unless you untick the box |
| "Setup not finished" exit when secrets are missing | Every job checks its configuration and exits cleanly with a clear message |
| Priority: power cut > crime > accident > civic > the rest | Topic priority with power cuts first (`src/pipeline/topic.ts`). Crime and accidents are flagged sensitive, so an editor decides. |
| Only today's news; finished power cuts and passed dates are skipped | Stale and expired stories are never drafted or published (`src/pipeline/freshness.ts`) |
| Neighbour districts are rejected even when close; a story naming both a Coimbatore place and a neighbour is kept | Same rule with an Erode gazetteer and a neighbour list (Tiruppur, Coimbatore, Salem, Namakkal, Karur, Nilgiris, Chamarajanagar) |
| Same event from two outlets is posted once | MinHash near-duplicate clustering, plus a check against everything published in the last 7 days |
| Reads Instagram's live `content_publishing_limit` before posting | Same, and our own cap is far lower (6 a day) |
| Weekly refresh of the 60-day Instagram token | `token-refresh.yml`, token stored encrypted in the bridge's Script properties |
| `ig_probe.yml` health check | `status.yml`, read-only, daily |
| Google Sheet as the working store, reached through an Apps Script web app with a key | Same idea: one tab per table in the `ErodeGlitz Newsroom` Sheet, reached only through `apps-script/Code.gs` (written for ErodeGlitz). The key travels in the request body, not the URL; writes hold the script lock; decisions, evidence and errors are append-only. Owner decision, 2026-10-30. |
| Images on Cloudinary, so Instagram can download them | Same, with signed uploads (no unsigned preset) |
| Regression tests named after real incidents, run on every push | `ci.yml` runs typecheck, lint and Vitest on every push |
| Finished media kept so a retry does not rebuild | Rendered cards are content-addressed on Cloudinary (the name is the image's SHA-256); a rerun reuses them |
| Official Instagram API (`graph.instagram.com`, `media` then `media_publish`) | Same API, same login type |

## 3. What ErodeGlitz deliberately does differently

| Coimbatore 360 | ErodeGlitz | Why |
|---|---|---|
| Every story posts automatically, including crime | Every post is approved by an editor on its GitHub issue. Sensitive stories need `/approve-sensitive`. | Owner's rule: human approval for sensitive, disputed or insufficiently verified stories. Phase 4 may allow auto-posting only for allowlisted official notices, such as power cuts, with a veto window. |
| One photorealistic AI-generated image per story, and its config has `ai_label: false` | Text-only Tamil cards. No AI images, no publisher photos. | A realistic picture of an event that was never photographed misleads readers. AI images of news are against the editorial policy (§9). |
| Free AI models rewrite the newspaper article | Phase 1 captions are editor-written or template-based (power-cut notices). AI drafting is a Phase 3 decision. | Publisher text may not be sent to AI unless its terms allow it. Dinamalar's robots.txt signals against AI use. AI never counts as verification. |
| Searches newspaper sites and Google/Bing News with a Chrome browser User-Agent | Only sources with a recorded terms review; robots.txt obeyed; the bot names itself (`ErodeGlitzBot/0.1`) | Permitted sources only (safety invariant 9) |
| An AI "fact gate" re-reads the article | Verification levels come from evidence only: an official source, two independent sources, or an editor's `/attest` | AI output never counts as verification |
| Up to 50 reels a day, posted the moment they are made | At most 6 posts a day, 08:00 to 21:00 IST, at least 30 minutes apart | Owner decision (cadence) and spam-risk control (risk R11) |
| Reels with a synthetic Tamil voice | Single-image posts (1080×1350) | Reels and video are non-goals for now. They can be a later phase if the owner wants them; a voice service would need its own terms review. |
| Queue files and logs committed to git by the bot | Everything is in the Sheet; the bot never commits | No runner or git state; the repository only changes through reviewed commits |
| Public repository | Private repository | Review issues contain unpublished, possibly unverified material |
| Story submission by e-mail to a bridge Gmail | Tips arrive as GitHub issues from a template and need the same verification | No inbound e-mail parsing; one audit trail |

## 4. Switches

Coimbatore 360 has three switches: the `research_free/ENABLED` file, the `LIVE` file and the `PAUSED` variable. ErodeGlitz keeps the idea, but no switch lives in a file that a bot commits.

| Switch | Where | Effect | Default |
|---|---|---|---|
| `COLLECTING_ENABLED` | Repository variable | Scheduled `collect`, `draft` and `status` runs start only when it is `true`. A skipped job costs no minutes. | not set (off) |
| `collecting_enabled` | Sheet (`settings` tab), set by **Actions → switch** | The collector refuses to run while it is off | off |
| `PUBLISHING_ENABLED` | Repository variable | `publish.yml` runs for real only when it is `true` | not set (off) |
| `publishing_enabled` | Sheet (`settings` tab), set by **Actions → switch** or `/killswitch on <reason>` on any issue | Checked before the container is created and again immediately before `media_publish` | off |
| `DRY_RUN` | Repository variable | Must be exactly `false` for a scheduled run to post | not set (dry run) |
| `PUBLISH_ON_APPROVAL` | Repository variable | When `true`, an approval starts `publish.yml` at once; otherwise the hourly run picks it up | not set (off) |

To stop everything at once: comment `/killswitch on <reason>` on any review issue, or set `PUBLISHING_ENABLED` to `false`. Only the owner can switch publishing back on.

## 5. Schedules and cost

All times IST (`timezone: "Asia/Kolkata"` on each cron entry). The minutes are estimates until the Phase 0 runner spike measures them.

| Workflow | When | Runner | Runs a month | Minutes a month (est.) |
|---|---|---|---|---|
| `collect.yml` | 06:07 to 22:07, every 2 h | `ubuntu-slim` | about 270 | about 540 |
| `draft.yml`, check job | after `collect` when something is new; safety net 07:37 to 19:37, every 4 h | `ubuntu-slim` | about 390 | about 390 |
| `draft.yml`, render job | only when the check finds work | `ubuntu-latest` (Chromium) | about 180 | about 360 |
| `review-command.yml` | each editor command | `ubuntu-slim` | about 600 | about 600 |
| `publish.yml` | after an approval; catch-up 08:47 to 20:47, every 2 h | `ubuntu-slim` | about 390 | about 390 |
| `status.yml` | daily 07:13 | `ubuntu-slim` | 30 | 30 |
| `token-refresh.yml` | Mondays 03:17 | `ubuntu-slim` | 4 | 4 |
| `ci.yml` | each push | `ubuntu-latest` | depends | about 100 |

GitHub rounds each job up to a whole minute, so even a job that exits at once costs one minute. A job skipped by its `if:` condition costs nothing.

Rough monthly cost against the USD 12 included on GitHub Free: `ubuntu-slim` about 1,950 minutes × USD 0.002 ≈ USD 3.90; `ubuntu-latest` about 460 minutes × USD 0.006 ≈ USD 2.80; total about USD 6.70. That is a little above the 50% target in the [operations runbook](OPERATIONS.md#9-cost-monitoring-and-budgets). The Phase 0 runner spike measures the real durations; if Chromium works on `ubuntu-slim`, the render job moves there and the total drops to about USD 5.

The Google Sheet adds time: each bridge call takes about 1–2 seconds, and a draft run makes several calls per new item. These estimates assume most runs still finish within a minute or two; recheck them against real run times in the first week of Phase 1.

## 6. What the owner does each day (once live)

1. Open the GitHub app → this repository → **Issues**. Each new story has one issue with the card preview, sources and checks.
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
| Set `COLLECTING_ENABLED=true` and switch collecting on: Phase 1 dry run for 14 days | Owner | Yes |
| Meta app, Instagram token for @erodeglitz, privacy-policy page, lawyer review | Owner | Yes (Phase 2) |
| First real post | Owner | Yes |
