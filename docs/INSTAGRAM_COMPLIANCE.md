# Instagram Compliance

> **Status:** policy for the planned system. Checked against Meta's official documentation on **2026-10-29**.
> Re-check every quarter, before each phase goes live, and whenever Meta announces a new Graph API version. Record each check in §13.
> This document is not legal advice.

## 1. Rules this project follows

ErodeGlitz publishes only through **Meta's official Instagram Platform API**, to **its own** Instagram professional account, using a token obtained through **Meta's own login or dashboard flow**.

## 2. Prohibited methods (never, in any phase)

- Logging in to Instagram from code with a username and password.
- Using browser cookies, session IDs or any credential copied from a browser or app.
- Browser automation (Playwright, Puppeteer, Selenium or similar) against instagram.com or the Instagram app. Playwright in this project renders local HTML templates only and never opens an Instagram or Facebook page.
- Private, mobile-app or otherwise undocumented endpoints, and libraries that emulate the Instagram app or website.
- Scraping Instagram or any other platform. Instagram's Terms of Use say you can't "access or collect information in unauthorized ways", including "collecting information in an automated way without our express permission".
- Buying or exchanging likes, followers or comments, or automating likes, follows or comments. Meta Developer Policy 2.7 prohibits programs that buy or sell engagement.
- Working around limits: extra apps, extra accounts, or parallel tokens to exceed quotas. Developer Policy 2.2 asks developers to respect "the limits we've placed on product functionality".
- Sharing the token with any third-party service, or storing it in plaintext, in git, in logs or in an LLM prompt.
- Posting content we do not have the rights to.

A code review that finds any of these is a release blocker.

## 3. Account and app requirements

| Requirement | Detail (official source in §14) |
|---|---|
| Account type | Instagram **professional** account (Business or Creator) |
| App type | Meta app of type **Business** |
| Integration | **Instagram API with Instagram Login** (Business Login for Instagram). No Facebook Page needed. |
| Host | `graph.instagram.com` |
| Token | Instagram User access token, long-lived |
| Permissions | `instagram_business_basic`, `instagram_business_content_publish`. Older `business_*` scope names were deprecated on 2025-01-27; do not use them. |
| Access level | **Standard Access.** Meta: Standard Access is "intended for apps that will only be used by people who have roles on them". Meta's App Review table lists "My app is only for a business I own or manage" as Standard Access with App Review **not required**. |
| Advanced Access | Not needed and not requested. It would require App Review and Business Verification, and is for serving accounts we don't own or manage. |
| App settings | A privacy policy URL is an App Settings field. Whether development mode allows publishing to our own account was not stated on the pages checked; verify during Phase 2 setup. |

Other configurations Meta offers, for reference:

- **Instagram API with Facebook Login for Business:** `graph.facebook.com`; the account must be linked to a Facebook Page; Page access token; permissions `instagram_basic`, `instagram_content_publish`, `pages_read_engagement`, plus `ads_management` or `ads_read` if the user has a Business Manager role on the Page.
- **Instagram API with Unified Login:** recommended by Meta "for new integrations"; uses a Business Integration System User access token; needs a business portfolio but no Page; `graph.facebook.com`. The pages checked did not explain how to obtain that token. Re-evaluate in Phase 2, because a system-user token might remove the 60-day refresh cycle (unverified).

## 4. API version policy

- The latest Graph API version when checked was **v26.0** (introduced 2026-07-29). v25.0 is available until 2028-07-29.
- The version is pinned in configuration (`IG_GRAPH_API_VERSION`). The changelog is reviewed every quarter, and the version is upgraded at least 6 months before the pinned one expires, after contract tests pass.

## 5. Publishing flow (official)

From Meta's content publishing guide:

1. **Create a container:** `POST /<IG_ID>/media` with `image_url` (JPEG on a publicly reachable server, which Meta fetches with a cURL-style request), plus optional `caption` and `alt_text`. Returns `{ "id": "<IG_CONTAINER_ID>" }`.
2. **Check status:** `GET /<IG_CONTAINER_ID>?fields=status_code`, which returns one of `IN_PROGRESS`, `FINISHED`, `ERROR`, `EXPIRED` or `PUBLISHED`. Meta's guidance: check "about once per minute, for no more than 5 minutes".
3. **Publish:** `POST /<IG_ID>/media_publish` with `creation_id`. Returns the Instagram media ID.
4. A container that is not published within **24 hours** expires.

How the project applies this is described in [Architecture §5.10](ARCHITECTURE.md#510-publishing).

## 6. Limits

| Limit | Meta's documentation | Project policy |
|---|---|---|
| Published posts per rolling 24 h | **Conflicting:** the content publishing page says 100 in one place and 50 in another; the `content_publishing_limit` reference says `quota_total` is "currently 50" with `quota_duration` 86400 | Read the live value from `GET /<IG_ID>/content_publishing_limit` before every publish; own cap `MAX_POSTS_PER_DAY` = 6 (owner decision, 2026-10-30) |
| Containers per rolling 24 h | 400 | Normally a handful a day; alert above 20 |
| Container lifetime | 24 h | Reuse only `FINISHED` containers less than 24 h old |
| Caption | at most 2,200 characters, 30 hashtags, 20 @-tags | about 1,800 characters, at most 5 hashtags, no @-mentions of individuals |
| `alt_text` | at most 1,000 characters; images only (added 2025-03-24) | Always set, in Tamil |
| Image format | JPEG only (MPO and JPS not supported) | JPEG |
| Image file size | at most 8 MB | target under 1 MB |
| Aspect ratio | 4:5 to 1.91:1 | 4:5 (1080×1350) |
| Width | 320 to 1440 px (scaled outside that range) | 1080 px |
| Colour space | sRGB (others are converted) | sRGB |
| Image URL | Must be publicly reachable when the container is created; US-ASCII URLs are safest | Public, ASCII-only Cloudinary URL named by a SHA-256 of the card's template version and text (cannot be guessed without the exact card text) |
| Carousel size | **Conflicting:** the guide says up to 20 items; error 2207028 says 2 to 10 | Not used until Phase 4; verify first |
| API calls | "Calls within 24 hours = 4800 * Number of Impressions", per app and user pair | A handful of calls per post; a new account with few impressions has a low ceiling, so avoid unnecessary calls |

## 7. Tokens

| Fact (official) | Project handling |
|---|---|
| Dashboard-generated tokens are long-lived, valid 60 days | Imported once from a temporary GitHub secret, then stored encrypted (AES-256-GCM) in the Sheet bridge's Script properties, never in a Sheet tab |
| Refresh: `GET https://graph.instagram.com/refresh_access_token` with `grant_type=ig_refresh_token`; the token must be at least 24 h old and unexpired, with `instagram_business_basic` granted | Weekly refresh job; alert below 14 days of remaining validity |
| A token not refreshed within 60 days expires and cannot be refreshed | Runbook: generate a new token in the dashboard and re-import it ([Operations §8](OPERATIONS.md#8-token-lifecycle)) |
| Long-lived token exchange "must be made in server-side code" | Never handled in a browser |

The token never appears in logs, URLs that are logged, issue comments, LLM prompts or artifacts. The publisher sends it in a header where the endpoint supports that (to be verified in Phase 2), and the logger redacts `access_token` everywhere.

## 8. Error handling

The project maps Meta's documented errors to actions. Full table: [Architecture §5.10](ARCHITECTURE.md#510-publishing). Summary:

- **Stop everything** (trip the kill switch and alert the owner): 4 / 2207051 ("We restrict certain activity to protect our community", flagged as spam), 25 / 2207050 (account restricted), and authentication or token errors.
- **Respect the quota:** 9 / 2207042 (publishing limit reached) means wait for the rolling window; it is never worked around.
- **Fix, don't retry:** URL not fetchable (9004 / 2207052), image too large, wrong format, wrong aspect ratio, caption too long. Each one points to a bug in our own validation.
- **Retry carefully:** server errors and download timeouts, with backoff and a cap.
- **Never re-publish blindly:** an ambiguous `media_publish` result is reconciled through the container status first.

## 9. Content policies

### Meta Developer Policies (last updated 2026-02-03)

- 1.2: app content must meet Meta's **Community Standards**.
- 1.4: "Don't confuse, deceive, defraud, mislead, spam or surprise anyone." This is why there is no clickbait and no misleading graphics, every claim is attributed, and corrections are prompt.
- 2.2: respect platform limits.
- 2.7: no buying or selling likes, followers or comments.
- 6.1: comply with restrictions on the use of Instagram user photos and videos.

### Instagram Terms of Use and Community Guidelines

- No unauthorised automated access or collection (see §2).
- Post only content we have the right to share; this is why the project uses no third-party photos.
- Avoid graphic or violent imagery. The API offers no sensitive-content screen, so such images are simply not used.
- No hate speech, harassment, sharing of private information, or content that could incite violence. See the red lines in the [editorial policy](EDITORIAL_POLICY.md#7-legal-and-ethical-red-lines).

### Spam avoidance

At most `MAX_POSTS_PER_DAY` posts, at least `MIN_MINUTES_BETWEEN_POSTS` apart, only inside the posting window. A small curated hashtag list. No repeated captions; the near-duplicate guard blocks re-posting the same story. No engagement bait.

## 10. AI disclosure

- Meta added `is_ai_generated` to container creation on **2026-06-22**. Setting it to `true` applies an "AI info" label at publish time. For carousels it goes on the carousel container only, never on the children.
- **Project rule:** no AI-generated or AI-altered images in news posts. If that ever changes with the owner's approval, every such post sets `is_ai_generated=true` **and** carries a visible label in the graphic.
- Captions drafted with AI help (Phase 3) are edited and approved by a human. The page's bio and published editorial policy disclose AI-assisted drafting. Meta's `is_ai_generated` is not set for template graphics made of text the editors approved.
- **India:** the IT (Intermediary Guidelines and Digital Media Ethics Code) Amendment Rules, 2026 (G.S.R. 120(E), notified 2026-02-10, in force 2026-02-20, according to secondary sources) introduce labelling duties for "synthetically generated information", meaning audio, visual or audio-visual material, mainly on intermediaries. A further draft amendment was published for comment in April 2026, and its status is unknown. Get legal advice on whether any obligation applies to ErodeGlitz.

## 11. Data handling

- **Stored:** Instagram user ID, container IDs, media IDs, permalinks, timestamps, quota snapshots, and redacted request and response metadata.
- **Not stored:** follower data, other users' content, insights. None of these features are used.
- The token is encrypted at rest. If the app is removed or access is revoked, the token row is deleted and publishing stops.
- If Meta requires a data-deletion callback or instructions URL when the app is in live mode, provide one before switching modes (verify in the dashboard).

## 12. Out of scope, and why

| Feature | Why not now |
|---|---|
| Comments, direct messages, mentions | More permissions, moderation burden, and a higher risk of policy violations |
| Insights | Not needed for publishing; maybe Phase 4 |
| Reels, Stories, video | Image posts are enough for the MVP |
| `location_id` | Needs a Facebook Page ID with location data |
| `user_tags`, `collaborators` | Tagging people in news can harm them; editorial risk |
| Partnership labels, product tags, polls | Not relevant; some are available only with Facebook Login |
| Deleting media through the API | `DELETE /{ig_media_id}` exists since 2025-12-03 with the `instagram_manage_contents` permission; whether it is available with Instagram Login must be verified first (Phase 4) |

## 13. Go-live compliance checklist (Phase 2)

- [ ] Account is professional; two-factor authentication is on for Instagram and Meta (Instagram: Creator account with two-factor on since 2026-10-30; Meta developer account still to do)
- [ ] App type is Business; only `instagram_business_basic` and `instagram_business_content_publish` granted
- [ ] No Advanced Access requested
- [ ] Privacy policy page live on GitHub Pages (public `erodeglitz-site` repository) and set in App Settings
- [ ] Token stored only encrypted; temporary secret deleted; redaction test passing
- [ ] Graph API version pinned and in support
- [ ] Live publishing quota read successfully
- [ ] Kill switch tested in every layer
- [ ] Editorial policy published, with a complaints contact
- [ ] A lawyer has reviewed the editorial policy and setup (owner decision, 2026-10-30)
- [ ] This document re-checked against the official pages; date recorded below

Verification log:

| Date | Checked by | Result |
|---|---|---|
| 2026-10-29 | Planning (Claude Code) | Documentation reviewed; nothing configured yet |

### Other platform policies that affect this design

- **GitHub Actions terms** (Terms for Additional Products, Actions section, effective 2026-08-27): "You may only access and use GitHub Actions to develop and test your application(s)." For GitHub-hosted runners, the terms prohibit "any other activity unrelated to the production, testing, deployment, or publication of the software project", and ask users not to use Actions "as part of a serverless application". Misuse "may result in termination of jobs, restrictions in your ability to use GitHub Actions". Running a production publishing pipeline may be outside that scope. This is risk R1 in the [project plan](../PROJECT_PLAN.md#7-risks-and-mitigations); the owner accepted it for the MVP on 2026-10-30.
- **GitHub Free, private repositories:** no environment secrets, no required reviewers or wait timers. The review gate is therefore implemented in our own code, not with GitHub Environments.

## 14. References

Official Meta documentation (checked 2026-10-29):

- Content publishing: <https://developers.facebook.com/docs/instagram-platform/content-publishing/>
- Instagram Platform overview: <https://developers.facebook.com/docs/instagram-platform/overview>
- Business Login for Instagram (tokens, refresh): <https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login>
- Get started with Instagram Login: <https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/get-started>
- App Review and access levels: <https://developers.facebook.com/documentation/instagram-platform/app-review>
- IG User media reference: <https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media>
- Content publishing limit: <https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit>
- IG Container reference: <https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-container>
- Error codes: <https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/error-codes>
- Instagram Platform changelog: <https://developers.facebook.com/documentation/instagram-platform/changelog>
- Graph API changelog and versions: <https://developers.facebook.com/docs/graph-api/changelog/>
- Meta Developer Policies: <https://developers.facebook.com/devpolicy/>
- Instagram Terms of Use: <https://help.instagram.com/581066165581870>

Other:

- GitHub Terms for Additional Products and Features: <https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features>
- India IT Rules amendment 2026, secondary reporting: Business Today (2026-02-10), Bar & Bench. Verify against the Gazette text with counsel.
