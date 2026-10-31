# ErodeGlitz

Tamil-first local news for Erode city and Erode district, posted to the Instagram account **@erodeglitz** through Meta's official Instagram API. Jobs run on GitHub Actions. As in Coimbatore 360, a Google Sheet (reached through a small Apps Script web app, `apps-script/Code.gs`) is the system of record, and card images are on Cloudinary.

The workflow layout follows the Coimbatore 360 auto-posting pattern (collect, draft, publish, switches), with an editor approving every post on a GitHub issue. See [docs/WORKFLOWS.md](docs/WORKFLOWS.md).

**Status:** Phase 1 setup, not live. As in Coimbatore 360, nothing posts until the owner adds a `LIVE` file to the repository root, and automatic collecting runs only after **Actions → collect-switch** → `start` ([switches](docs/WORKFLOWS.md#4-switches)). Every post also needs an editor's approval.

```bash
pnpm install
pnpm run check            # typecheck, lint, tests
pnpm run render:samples   # sample Tamil cards in out/samples/
```

| Document | Contents |
|---|---|
| [PROJECT_PLAN.md](PROJECT_PLAN.md) | Goals, phases, decisions, risks |
| [docs/WORKFLOWS.md](docs/WORKFLOWS.md) | Workflows, switches, schedules, cost; what was taken from Coimbatore 360 and what was changed |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data model, safety mechanisms |
| [docs/SETUP_GUIDE.md](docs/SETUP_GUIDE.md) | Manual setup steps and the approval each needs |
| [docs/EDITORIAL_POLICY.md](docs/EDITORIAL_POLICY.md) | Verification, sensitive topics, Tamil style |
| [docs/INSTAGRAM_COMPLIANCE.md](docs/INSTAGRAM_COMPLIANCE.md) | What the official API allows |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Kill switch, runbooks, costs |
