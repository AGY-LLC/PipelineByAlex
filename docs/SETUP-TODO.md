# Setup TODO (delete this file once done)

One-time manual steps to make the central pipeline usable from app repos.
Everything in the repo/code is already done; this is the GitHub-UI part.
Full reference: [`usage.md`](./usage.md).

## Already done ✅

- [x] PR merged to `main`
- [x] `v1` tag pushed (callers can use `@v1`)
- [x] `pipelinebyalex` repo made **public** (no token needed for the interpreter checkout)

## Org-level (once, AGY-LLC → Settings → Secrets and variables → Actions → New organization secret)

Add only the account tokens you actually use:

- [ ] `FLY_API_TOKEN`
- [ ] `VERCEL_TOKEN`
- [ ] `VERCEL_ORG_ID`
- [ ] `EXPO_TOKEN`
- [ ] Scope each to the app repos that need it (or "All repositories")

## Per app repo (repeat for each repo you onboard)

Commit two files:

- [ ] `.github/workflows/ci.yml` — the caller (from `examples/app-repo/`)
- [ ] `pba.yml` — that repo's pipeline (from `examples/app-repo/`)
- [ ] Make sure the repo actually has what the scripts call (`pnpm test`,
      `pnpm run typecheck`, `Dockerfile`, prisma scripts, …)

Repo secret (only if it deploys to Vercel):

- [ ] `VERCEL_PROJECT_ID` (Repo → Settings → Secrets and variables → Actions)

Environments (only if it has deploy targets) — Repo → Settings → Environments:

- [ ] Create environments whose names **exactly match** `target.environment` in
      that repo's `pba.yml` (e.g. `staging`, `production`)
- [ ] In each environment add `DATABASE_URL` + `DIRECT_URL` (that env's values)
- [ ] (Optional) On `production`: required reviewers + restrict deployment
      branches to `main`

## Verify

- [ ] Push a feature branch → `plan` + `test` + `gates` run, `deploy` skipped
- [ ] Merge to `main` (or staging) → `deploy` runs the ordered chain, gated on CI
- [ ] Check the `plan` job log: it prints the matrices derived from `pba.yml`

## Optional / later

- [ ] Publish `pba` to npm to drop the in-workflow interpreter checkout
- [ ] Add the iOS/macOS self-hosted runner path for Maestro tests
- [ ] If you ever make `pipelinebyalex` private again: enable org workflow
      accessibility + add `PBA_READ_TOKEN` (see `usage.md` §3)
