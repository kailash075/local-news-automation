# ErodeGlitz: Project Plan

> **Status, 2026-10-30: Phase 0 code pushed; `ci` passes.** The pipeline code, the workflows (following the Coimbatore 360 pattern the owner asked for, see [Workflows](docs/WORKFLOWS.md)) and 334 passing tests are on GitHub. The `ErodeGlitz Newsroom` Sheet and its Apps Script bridge are set up, and the migrate run created the tabs and passed its self test. Cloudinary, the Meta app, the Instagram token and every other external piece do not exist yet, no switch is on, and nothing has been posted.
> Last updated: 2026-10-30. External facts below were checked against official documentation on that date. Re-check them before each phase goes live, because Meta, GitHub and the hosting providers change their products and terms often.

ErodeGlitz is a Tamil-first Instagram page for local news from Erode city and Erode district, Tamil Nadu. This repository will hold an automated newsroom pipeline that:

1. collects items from sources whose terms permit it,
2. removes duplicates and groups reports of the same event into one story,
3. records how each story was verified,
4. drafts a Tamil caption and a Tamil news graphic,
5. sends the story to a human editor, and
6. publishes approved stories through Meta's official Instagram API.

Scheduled jobs run on GitHub-hosted runners, so nothing depends on the owner's PC being switched on. A Google Sheet, reached through a small Apps Script web app, is the system of record (the same pattern as Coimbatore 360).

Related documents:

- [Architecture](docs/ARCHITECTURE.md): components, data model, workflows, safety mechanisms
- [Setup guide](docs/SETUP_GUIDE.md): manual setup steps, each marked with the approval it needs
- [Instagram compliance](docs/INSTAGRAM_COMPLIANCE.md): what the official API allows and what this project will never do
- [Editorial policy](docs/EDITORIAL_POLICY.md): verification levels, sensitive topics, legal red lines, Tamil style
- [Operations](docs/OPERATIONS.md): schedules, kill switch, alerts, incident runbooks, costs, backups

---

## 1. Current state (inspected 2026-10-29)

### Repository

| Item | Finding |
|---|---|
| Files | `README.md` (2 lines) and `.gitignore` (standard Node.js template that already ignores `.env`, `.env.*` except `.env.example`, `node_modules/`, `dist`, `coverage`) |
| History | One commit, `9be463f Initial commit`, on `master`. Working tree clean. |
| Remote | `origin` = `https://github.com/kailash075/local-news-automation.git`, visibility **private** |
| Code, CI, tests | None |

### Local environment (Ubuntu 24.04.5 LTS, x86_64)

| Tool | Found | Notes |
|---|---|---|
| Node.js | v22.23.2 | The plan targets Node.js 26, which became Active LTS on 2026-10-28 (end of life 2029-04-30). Node 24 is a fallback (maintenance LTS until 2028-04-30). Node 22 reaches end of life on 2027-04-30. |
| pnpm | 11.20.0 | OK |
| corepack | 0.34.6 | |
| TypeScript | no global `tsc` | Will be a project dev dependency |
| git | 2.43.0 | |
| GitHub CLI | 2.100.0 | Two accounts logged in (see below) |
| Containers | podman 4.9.3; Docker not installed | Not needed. Storage tests run the bridge code against an in-memory fake Sheet. |
| psql, sqlite3 | not installed | Not needed |
| ffmpeg, ImageMagick | not installed | Not needed for image posts |
| Tamil fonts | Noto Sans Tamil, Noto Serif Tamil | The project will bundle its own font files so every runner renders the same way |

### GitHub access

- `gh` is logged in to two accounts. The globally **active** account, `kailashrajendiran`, gets HTTP 404 for this repository, so it has no access.
- `kailash075` owns the repository. Since 2026-10-30 this repository has local git settings that commit as `kailash075` and push with its saved login, without changing the global account ([setup guide §2](docs/SETUP_GUIDE.md#2-local-development)).
- `kailash075` is on **GitHub Free** (confirmed 2026-10-30: GitHub refuses branch protection on this private repository with "Upgrade to GitHub Pro"). On Free, a private repository gets **USD 12 per month of included Actions compute**, and has **no branch protection**, **no environment secrets** and **no required-reviewer deployment protection** (see [Operations §9](docs/OPERATIONS.md#9-cost-monitoring-and-budgets)).

### Done since (2026-10-30, local only, not pushed)

- TypeScript project (pnpm, strict settings from [Architecture §11](docs/ARCHITECTURE.md#11-code-organisation-and-coding-standards), ESLint, Vitest), domain types and state machine, verification and gates.
- Collectors, Erode gazetteer and relevance, topic, risk, freshness, clustering; source registry with every external source `pending` and disabled.
- Storage on a Google Sheet, as in Coimbatore 360 (owner request, 2026-10-30, replacing the Supabase plan): the Apps Script bridge `apps-script/Code.gs`, the tab layout, the stores and a Sheets self test. The same contract tests run on the Sheet stores (real bridge code on a fake Sheet) and on the in-memory stores. Card images on Cloudinary with signed uploads.
- Text-only Tamil card renderer with bundled Noto fonts; sample cards in `out/samples/` for the owner to check.
- Review desk (commands, authorisation, issue body), publisher with gates, leases and reconciliation, Instagram client (never called live).
- Workflows: `ci`, `collect`, `draft`, `review-command`, `publish`, `switch`, `status`, `token-refresh`, `migrate`. Not written yet: `import-token`, `maintenance` (backup, retention, digest), the editor-tip issue form.
- Local result: typecheck and lint clean; `pnpm test` 29 files, 317 tests passed (Node 22.23.2; Node 26 not yet tried).
- The earlier Postgres and Supabase code is kept, uncommitted, in `out/backup/postgres-supabase-store-2026-10-30.tar.gz` (git-ignored).

### Not done

None of the following exists yet: the `ErodeGlitz Newsroom` Sheet and its Apps Script bridge, a Cloudinary account, a Meta developer app, an access token, an Anthropic account, GitHub secrets or variables, or any post. No Instagram, Google or Cloudinary API call has been made; the bridge has only run inside the test fake.

---

## 2. Goals and non-goals

### Goals

- Publish accurate, attributed, Tamil-first local news for Erode city and district.
- Automate the repetitive work: collection, de-duplication, formatting, rendering, scheduling.
- Keep humans in charge of editorial judgment. Software assists; editors decide.
- Use only official, permitted APIs and sources.
- Run unattended on GitHub-hosted runners, at zero or near-zero cost.
- Be safe to operate: one switch stops all publishing; no duplicate posts; every decision is auditable.

### Non-goals (for now)

- A website or app for readers.
- Reels, Stories or video.
- Automated comments, direct messages, likes or follows.
- Reading or scraping any social-media platform, including Instagram, Facebook, X or WhatsApp.
- Advertising, sponsored posts or monetisation.
- Serving other people's Instagram accounts (that would require Meta App Review and Advanced Access).
- AI-generated photographs or photorealistic illustrations.

---

## 3. Safety invariants

These rules hold in every phase. Code, tests and reviews enforce them.

1. **Human approval.** Every post needs an editor's approval through Phase 3. In Phase 4, auto-publishing may be enabled only by the owner, only for allowlisted low-risk categories from official sources, and only with a veto window. Sensitive, disputed or insufficiently verified stories always need human approval.
2. **AI never verifies.** AI output can raise risk flags. It can never lower a risk tier, count as verification evidence, or approve a post. The evidence types in code have no AI variant.
3. **Official channels only.** Publishing uses Meta's Instagram Platform API with a token issued through Meta's own login flow. No passwords, browser cookies, scraped credentials, browser automation or unofficial endpoints, ever.
4. **Fail closed.** Missing configuration, a failed check, an unknown state or an unreachable dependency means "do not publish".
5. **Publishing is off by default.** The kill switch starts in the off position. It is checked again immediately before each irreversible API call.
6. **Idempotent external writes.** Every external write is recorded before and after it happens. An ambiguous result is reconciled before anything is retried.
7. **The Google Sheet is the system of record.** The runner filesystem, workflow artifacts and caches are scratch space only.
8. **Explicit approval for anything outward-facing.** No account creation, spending, setting changes or posts happen without the owner's explicit approval.
9. **Permitted sources only.** A source's terms and robots rules are reviewed and recorded before the collector may fetch it.
10. **Secrets stay secret.** Secrets never appear in git, logs, issue comments or LLM prompts.

---

## 4. Proposed key decisions

| Area | Proposal | Main reason | Alternatives considered |
|---|---|---|---|
| Runtime | Node.js 26 LTS, ES modules | Current Active LTS; supported until April 2029 | Node 24 LTS |
| Language and tooling | TypeScript (`strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), domain types declared with `type`, Zod 4, Vitest, ESLint with typescript-eslint strict type-checked rules, pnpm 11 | Requested; catches whole classes of bugs at compile time | — |
| Scheduler and compute | GitHub Actions on GitHub-hosted runners | Owner requirement; free tier; no server to maintain | Cloud Run Jobs, a small VM (see risk R1) |
| Storage | Google Sheet in the `erodeglitz@gmail.com` account, reached through an Apps Script web app with a key and a script lock (owner decision, 2026-10-30) | Same as Coimbatore 360; free; the owner can read everything in the Sheet | Supabase Postgres (the earlier plan); Neon Postgres |
| Card images | Cloudinary Free, signed uploads, public URLs named by the image's SHA-256 | Instagram must fetch images from a public URL; same as Coimbatore 360 | Supabase Storage with signed URLs (the earlier plan); Cloudflare R2 |
| Data access | Typed stores over the bridge, every row parsed with Zod; tests run the real bridge code on a fake Sheet | No database driver; no Docker needed in tests | — |
| Instagram integration | Instagram API with Instagram Login (`graph.instagram.com`), Standard Access, own account only | Fully documented; no Facebook Page needed; Meta's table says App Review is not required for an app used only for a business you own | Unified Login (Meta recommends it for new integrations, but its token setup was not fully documented when checked); Facebook Login for Business |
| Review desk | GitHub Issues in this private repository, with slash commands in comments | Free; works from the GitHub mobile app; full audit trail; no new account | Telegram bot (Phase 4 option) |
| Graphics | HTML/CSS templates rendered by headless Chromium (Playwright) with bundled SIL OFL Tamil fonts, exported as JPEG | Chromium uses HarfBuzz, which shapes Tamil correctly; HTML is easy to design | Canvas libraries; SVG-based renderers whose Tamil shaping is unproven |
| Captions | Phase 1: editor-written or template captions. Phase 3: Claude via `@anthropic-ai/sdk` structured outputs, default model `claude-opus-5-5`, under a hard budget | Zero cost until the owner approves spending; AI is an assistant, not an author of record | Other LLM providers |
| Alerts | GitHub issues labelled `ops-alert` | Free email and mobile notifications | Email or Telegram |

---

## 5. Phased implementation plan

Each phase ends with exit criteria and the owner's sign-off. A later phase never starts by quietly creating accounts or spending money; the approvals each phase needs are listed up front.

### Phase 0: Foundations (no external accounts, no spending)

**Goal:** a typed, tested skeleton, and proof that Tamil graphics render correctly.

Deliverables:

- `package.json` (`"type": "module"`, `engines`), `.node-version`, pnpm lockfile, `.env.example` with placeholder values only.
- `tsconfig.json` with the settings in [Architecture §11](docs/ARCHITECTURE.md#11-code-organisation-and-coding-standards); ESLint flat config enforcing `type` over `interface`, no `any`, no unsafe access, exhaustive switches; Vitest with coverage thresholds for the domain and publishing modules.
- `src/domain`: story, source item, verification evidence, risk assessment, draft revision, editorial decision and publication types, each with a Zod schema checked against the type. Pure state-machine functions with unit tests.
- Configuration loader with Zod validation and fail-closed defaults (`PUBLISHING_ENABLED=false`, `DRY_RUN=true`).
- **Rendering spike:** one HTML template rendered by Chromium with bundled Noto Sans Tamil into a 1080×1350 JPEG. Sample images go to the owner to confirm the Tamil text is shaped correctly.
- **Storage spike:** done differently: the Sheet bridge runs inside Vitest with a fake Sheet; the real-Sheet self test runs in the `migrate` workflow.
- `ci.yml`: frozen-lockfile install, typecheck, lint, test. Third-party actions pinned to full commit SHAs. Dependabot for npm and GitHub Actions.
- **Runner spike:** run the render step once on `ubuntu-slim` and once on `ubuntu-latest` via `workflow_dispatch`, and record durations. This decides the minutes budget.

Approvals needed: pushing commits to the repository; a few minutes of Actions usage.

Exit criteria: CI green; owner approves the sample graphics; measured job durations recorded in [Operations](docs/OPERATIONS.md).

### Phase 1: Dry-run newsroom (everything except the Instagram call)

**Goal:** the whole pipeline running on schedule, with the publisher in dry-run mode.

Deliverables:

- The `ErodeGlitz Newsroom` Google Sheet with the Apps Script bridge deployed, and a Cloudinary Free account.
- Tabs for settings, sources, source items, story sources, stories, evidence, drafts, decisions, review threads, publications, publish attempts, job runs and errors; the encrypted token in the bridge's Script properties.
- Source registry with a terms-review gate. The owner reviews and approves the first 3 to 6 sources.
- Collectors for RSS/Atom feeds, sitemaps and approved listing pages, with conditional GET, a robots.txt check, per-source rate limits and an identifying User-Agent.
- Tamil-aware normalisation; exact and near-duplicate detection; story clustering; an Erode relevance filter based on a place-name gazetteer; rule-based risk tiers.
- The review desk in GitHub Issues: one issue per story; commands such as `/caption`, `/approve`, `/approve-sensitive`, `/attest`, `/hold`, `/reject` and `/killswitch`; an editor allowlist; approvals bound to a revision hash.
- Editor-written or template captions (no LLM yet). Rendering to Cloudinary, with previews at the card's unguessable URL.
- A publisher in **dry-run mode** that evaluates every gate and records "would publish", and never calls Instagram.
- Operations basics: job-run records, error records, `ops-alert` issues, a daily digest, a weekly download of the Sheet, retention clean-up.

Approvals needed: creating the Sheet and deploying the bridge; creating the Cloudinary account; the initial source list; the editor list.

Exit criteria: at least 14 consecutive days of scheduled dry runs; no unhandled errors in the last 7 days; the owner has reviewed duplicate and relevance quality; Actions usage within budget.

### Phase 2: Human-approved Instagram publishing

**Goal:** publish approved stories through the official API with every safety rail in place.

Deliverables:

- A Meta app of type Business using the Instagram API with Instagram Login, and a long-lived token for the ErodeGlitz professional account. The owner performs these steps; see the [setup guide](docs/SETUP_GUIDE.md#6-meta-and-instagram-phase-2-approval).
- A token import workflow that stores the token encrypted; a weekly refresh workflow; expiry alerts.
- A typed Instagram client with Zod-validated responses. A publisher with gates, leases, container reuse, reconciliation, error classification and automatic kill-switch trips.
- Contract tests built from documented responses, plus fault-injection tests for a timeout at every step.
- Go-live procedure: the owner explicitly approves the first post. For the first two weeks, each publish run is started by the owner by hand before approval-triggered publishing is switched on.

Approvals needed: creating the Meta app; generating the token; creating the public `erodeglitz-site` repository for the privacy policy page (GitHub Pages); the first post; switching `PUBLISHING_ENABLED` on. Before the first public post, a lawyer reviews the editorial policy and setup (owner decision, 2026-10-30).

Exit criteria: 20 posts published with zero duplicates; no unknown publish state left unresolved for more than one hour; token refresh exercised successfully.

### Phase 3: AI-assisted Tamil drafting (optional, paid)

**Goal:** less editor time per story, without weakening verification.

**Decision deferred:** the owner decides after Phase 2 whether to do this phase at all (2026-10-30). Until then, captions are editor-written or template-based, at no cost.

Deliverables:

- A fact-sheet builder that turns clustered source items into structured facts, each linked to its source.
- A `CaptionDrafter` implementation using Claude through `@anthropic-ai/sdk` structured outputs, with the output schema written in Zod. Default model `claude-opus-5-5`. Drafts are produced only for shortlisted stories.
- Validators: schema, lengths, hashtag and mention limits, Tamil-script ratio, every number, date and name must appear in the fact sheet, banned phrases, no URLs.
- AI risk flags that can only escalate.
- A cost ledger with hard monthly and daily caps, plus a workspace spend limit set by the owner in the Claude Console.
- An evaluation set of about 50 past Erode stories, graded by a Tamil-speaking editor, used to compare models and effort levels. Choosing a cheaper model is the owner's decision, made from these results.

Approvals needed: Anthropic account, API key, monthly budget; model choice after the evaluation.

Exit criteria: agreed quality bar met (for example, 90% "publishable with minor edits" and zero invented facts); measured cost within budget.

### Phase 4: Hardening and optional narrow automation

- Optional auto-publishing for allowlisted low-risk official categories, such as scheduled power shutdowns or IMD weather advisories, with a veto window. Off by default; the owner enables each category separately.
- Corrections and retraction tooling, including deletion through the API if the `instagram_manage_contents` permission is available for this login type (to be verified).
- Carousels for multi-item notices; Tamil and English alt text; insights reporting.
- A second editor, and a two-person rule for the highest-risk categories.
- Optional: a Telegram review bot; moving off GitHub Actions if risk R1 materialises.

### Milestone checklist

- [x] Owner decisions recorded (§8)
- [ ] Phase 0 complete (code and local tests done, sample graphics approved by the owner 2026-10-30; push, CI and runner spike pending)
- [x] Storage decided: Google Sheet with an Apps Script bridge, like Coimbatore 360 (2026-10-30; replaces the Supabase approval)
- [ ] Sheet and bridge set up by the owner; `migrate` self test passes
- [ ] Cloudinary account created by the owner (needs approval)
- [ ] Phase 1 dry run: 14 days clean
- [ ] Meta app and token set up by owner
- [ ] First post approved by owner
- [ ] Phase 2 exit criteria met
- [ ] Phase 3 approved, evaluated and enabled (optional)

---

## 6. Cost plan (summary)

| Item | Expected monthly cost | Notes |
|---|---|---|
| GitHub Actions | USD 0 if usage stays inside the plan's included compute | GitHub Free includes USD 12 per month for private repositories. Linux 2-core runners cost USD 0.006 per minute and the 1-vCPU `ubuntu-slim` runner costs USD 0.002 per minute. Without a payment method, usage is blocked (not billed) once the allowance is used up. Target: no more than 50% of the allowance. |
| Google Sheet and Apps Script | USD 0 | Up to 10 million cells per Sheet. Version history is built in; the owner also downloads a copy weekly. |
| Cloudinary | USD 0 (Free plan) | Check the Free plan limits on the pricing page at setup; ErodeGlitz needs a few hundred MB a year. |
| Instagram Platform API | USD 0 | |
| Claude API (Phase 3 only, optional) | Depends on volume and model; see [Operations §9](docs/OPERATIONS.md#9-cost-monitoring-and-budgets) | Rough estimate with `claude-opus-5-5` (USD 4 / 20 per million input/output tokens): about USD 0.03 to 0.05 per draft, so 20 drafts a day is roughly USD 20 to 30 a month before Batch API (50% off) or a cheaper-model decision. Hard cap enforced in code and in the Console. |

---

## 7. Risks and mitigations

| ID | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| R1 | **GitHub Actions terms.** GitHub's Terms for Additional Products (Actions section, effective 2026-08-27) say Actions may only be used "to develop and test your application(s)". For GitHub-hosted runners they prohibit "any other activity unrelated to the production, testing, deployment, or publication of the software project", and say not to use Actions "as part of a serverless application". A production news pipeline may be read as outside that scope. GitHub may terminate jobs, restrict Actions or disable the repository. | Medium / High | Accepted by the owner for the MVP (2026-10-30). Keep usage light; keep all logic in plain CLI commands so another scheduler can run them unchanged; keep a documented migration path ([Operations §13](docs/OPERATIONS.md#13-contingency-moving-off-github-actions)); consider asking GitHub Support before Phase 2. |
| R2 | Meta API changes or inconsistent documentation. The publishing limit is documented as both 50 and 100 posts per 24 hours, and the carousel size as both 10 and 20 items. | Medium / Medium | Read the live quota from `content_publishing_limit`; keep our own cap far lower; pin the Graph API version; review the docs every quarter; contract tests. |
| R3 | The token expires (60 days) or is revoked, and publishing stops. | Medium / Medium | Weekly refresh; alert when fewer than 14 days remain; kill switch trips automatically on authentication errors. |
| R4 | Legal harm: defamation, identifying a protected victim, contempt of court. | Low to medium / Very high | Human approval; risk tiers; legal red lines in the editorial policy; corrections process; legal review before public launch. |
| R5 | Copyright infringement from reusing a publisher's text or photos. | Medium / High | Facts-only original summaries with attribution; no third-party photos; recorded terms review for each source. |
| R6 | AI hallucination, or prompt injection hidden in source text. | Medium / High | The model drafts only from the fact sheet; deterministic validators; the model has no tools; human approval; AI never verifies. |
| R7 | Tamil rendering errors (broken conjuncts or misplaced vowel signs). | Medium / Medium | Chromium with HarfBuzz shaping; bundled fonts; owner sign-off in Phase 0; render snapshot tests. |
| R8 | Scheduled runs delayed or dropped. GitHub documents delays at high load, especially at the start of every hour, and says some queued jobs may be dropped. | High / Low | Off-the-hour cron minutes; idempotent catch-up; nothing depends on a single run. |
| R9 | The included Actions compute runs out (private repository), and runs are blocked. | Medium / Medium | Budget table; `ubuntu-slim` where feasible; GitHub's 90% and 100% usage emails; reduce the schedule. |
| R10 | The Google Sheet is edited or damaged by hand, or the bridge is unreachable. A Sheet has no transactions and no database constraints. | Medium / Medium | Only the owner has access; the bridge enforces unique keys, leases and append-only tabs under a lock; every row is parsed on read; Sheet version history and weekly downloads; jobs fail closed when the bridge does not answer. |
| R11 | Instagram treats the account as spam (error 4 / 2207051) or restricts it (25 / 2207050). | Low / High | Low cadence with minimum spacing; no hashtag stuffing; human-reviewed content; publishing stops at the first such error. |
| R12 | A single editor becomes a bottleneck. | High / Medium | Mobile-friendly review through the GitHub app; review targets; add a second editor. |
| R13 | Regulation of digital news publishers in India (IT Rules 2021 Part III; the IT Rules amendment of 2026 on synthetically generated information; the Digital Personal Data Protection Act 2023). | Unknown / High | Legal consultation before public launch; written policies; grievance contact. |

---

## 8. Owner decisions

Recorded 2026-10-30.

| # | Topic | Decision |
|---|---|---|
| 1 | GitHub account and plan | `kailash075` owns the repository and workflows. Plan confirmed as **GitHub Free**. |
| 2 | Risk R1 (GitHub Actions terms) | Accepted for the MVP. Jobs stay portable; revisit before Phase 2. |
| 3 | Storage | **Google Sheet with an Apps Script bridge, same as Coimbatore 360** (2026-10-30; replaces the earlier Supabase approval). Card images on Cloudinary. The owner creates the Sheet, the bridge and the Cloudinary account at the start of Phase 1 ([setup guide §4](docs/SETUP_GUIDE.md#4-google-sheet-and-apps-script-bridge-phase-1-approval) and [§5](docs/SETUP_GUIDE.md#5-cloudinary-for-card-images-phase-1-approval)). Not created yet. |
| 4 | Git identity on this PC | Repository-local settings: author `kailash075` with its GitHub noreply email; the remote URL uses `kailash075`'s saved `gh` login. Other repositories are unchanged. Applied 2026-10-30. |
| 5 | Approvers | Only `kailash075`. No second editor for now. |
| 6 | Initial sources | All four kinds: government announcements; power-cut and weather notices; newspapers (discovery only); editor tips. The owner nominated the Dinamalar Erode district page ([editorial policy §3](docs/EDITORIAL_POLICY.md#3-sources)). Every source still needs a recorded terms review before collection. |
| 7 | Cadence | At most **6 posts a day**, **08:00 to 21:00 IST**, at least **30 minutes** apart. |
| 8 | AI drafting (Phase 3) | Decide after Phase 2. |
| 9 | Privacy policy page | GitHub Pages from a new public repository (for example `kailash075/erodeglitz-site`), created in Phase 2 with the owner's approval. GitHub Free cannot publish Pages from this private repository. |
| 10 | Legal review | A lawyer reviews the editorial policy and setup before the first public post. |
| 11 | Instagram account | `erodeglitz` is a **Creator** professional account (set by the owner, 2026-10-30). Creator accounts work with the Instagram API with Instagram Login ([setup guide §5.1](docs/SETUP_GUIDE.md#61-instagram-account-manual)). |
| 12 | Complaints and corrections contact | `erodeglitz@gmail.com`, published in the Instagram bio and on the policy page. |

Still open: none.

---

## 9. Next actions

**Owner:**

- Finish the Instagram bio with the contact email ([setup guide §5.1](docs/SETUP_GUIDE.md#61-instagram-account-manual), step 3).
- Turn on two-factor authentication for `erodeglitz@gmail.com`. That account will also hold the newsroom Sheet and the bridge, so it needs the same protection.

**Next engineering steps:**

- Done 2026-10-30: the owner checked the sample cards in `out/samples/`; Tamil text and layout are correct.
- Owner approval needed: commit and push this work to `master` as `kailash075`. The push starts `ci.yml` (a few Actions minutes). Scheduled workflows stay idle until the repository variables are set.
- Runner spike: run `draft.yml`'s render job once on `ubuntu-slim` to see whether Chromium works there; record durations in [Operations §9](docs/OPERATIONS.md#9-cost-monitoring-and-budgets).
- Still to write: `import-token.yml`, `maintenance.yml` (backup export, retention, daily digest), the editor-tip issue form, and a parser for structured power-cut notices so the template caption can be used.
