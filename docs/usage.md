# Using pipelinebyalex — from merge to first green run

Step-by-step for taking the central interpreter live and onboarding an app repo.
Architecture background: [`runtime-interpreter-plan.md`](./runtime-interpreter-plan.md).

---

## 0. Smoke-test inside this repo first (recommended)

Validate the machinery with **zero** cross-repo or secret setup. A reusable
workflow can be called by another workflow in the *same* repo, so:

1. Add a minimal `pba.yml` here with one trivial component (e.g. `test` → `echo ok`).
2. Add a self-test caller `.github/workflows/selftest.yml`:
   ```yaml
   name: selftest
   on: [push, workflow_dispatch]
   jobs:
     ci:
       uses: ./.github/workflows/pipeline.yml
       with:
         pba_ref: ${{ github.sha }}   # check out THIS commit's interpreter
       secrets: inherit
   ```
3. Push the branch and watch `plan → test → gates` run.

Because the caller and the interpreter are in the same repo, the default
`GITHUB_TOKEN` can read both — none of the §3 cross-repo issues apply. This
proves the interpreter and matrix fan-out work before any real repo points at it.

---

## 1. Merge the PR

`pipeline.yml` + the interpreter land on `main` of `pipelinebyalex`.

## 2. Tag `v1`

Callers pin `@v1`, and `pipeline.yml` re-checks-out the interpreter at `@v1`, so
the tag must exist:

```bash
git checkout main && git pull
git tag v1 && git push origin v1
```

Re-point it after future non-breaking changes:

```bash
git tag -f v1 && git push -f origin v1
```

## 3. Make the central repo reachable ⚠️ (most common first-run failure)

`pipeline.yml` checks out `AGY-LLC/pipelinebyalex` to get the interpreter. The
default `GITHUB_TOKEN` can **only read the calling repo**, so:

- **If `pipelinebyalex` is public** → works as-is. Simplest; it holds no secrets.
- **If private** → two things:
  1. Org → Settings → **Actions → General → Accessibility** → allow this repo's
     workflows to be used by other repos.
  2. Pass a token with read access to the checkout step. Add a PAT (or GitHub
     App token) as a secret and wire it in (see the optional `token` input note
     in the plan doc), e.g. `token: ${{ secrets.PBA_READ_TOKEN }}` on the
     "Checkout pba interpreter" step.

> Symptom if skipped: the **Checkout pba interpreter** step fails with a
> 404 / permission error.

## 4. Add secrets + environments (once, org-level)

- **Org secrets**: `FLY_API_TOKEN`, `VERCEL_TOKEN`, `VERCEL_ORG_ID`,
  `VERCEL_PROJECT_ID`, `EXPO_TOKEN`.
- **GitHub Environments** `staging` and `production`, each with `DATABASE_URL`
  and `DIRECT_URL` secrets. The deploy job binds the environment from the plan
  and picks these up automatically (this is why the deploy script uses
  unprefixed `DATABASE_URL`, not `STAGING_DATABASE_URL`).
- Attach required reviewers to `production` here if you want manual approval
  before deploys.

## 5. Onboard an app repo

Commit exactly two files to the app repo:

1. `.github/workflows/ci.yml` — the caller (copy from
   [`../examples/app-repo/.github/workflows/ci.yml`](../examples/app-repo/.github/workflows/ci.yml)):
   ```yaml
   name: CI
   on:
     push: { branches: [main, staging] }
     pull_request: { branches: [main, staging] }
   jobs:
     ci:
       uses: AGY-LLC/pipelinebyalex/.github/workflows/pipeline.yml@v1
       secrets: inherit
   ```
2. `pba.yml` — the repo's real pipeline (see
   [`../examples/app-repo/pba.yml`](../examples/app-repo/pba.yml)).

The app repo must contain whatever the scripts call — `pnpm test`,
`pnpm run typecheck`, a `Dockerfile` for docker components, `prisma` scripts for
migrate targets, etc.

## 6. Watch it run

- **Feature branch / PR** → `plan`, `test`, `gates` run; `deploy` is skipped.
- **Push/merge to `main`** → `deploy` runs the ordered chain, and only if
  `test` + `gates` are green (a red check blocks it).
- The `plan` job log prints the matrices derived from `pba.yml` — the quickest
  way to confirm the interpreter read the config correctly.

---

## First-run troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Checkout pba interpreter` fails (404 / perms) | private central repo, default token can't read it | §3 — make public, or pass a read token |
| `plan` ok but `test` matrix empty / job skipped | no `components` in `pba.yml`, or `components == '[]'` | add components |
| component job fails on `pnpm: not found` | component `setup` not `node` but script uses pnpm | check `language`/`docker` in `pba.yml` |
| deploy never runs on `main` | ref doesn't match a `deploy.<branch>` key, or a check failed | confirm a `deploy.main` block; check `test`/`gates` results |
| migrate step can't connect to DB | `DATABASE_URL`/`DIRECT_URL` not set on the bound Environment | §4 — add Environment secrets |
| `@v1` not found | tag never pushed | §2 |
