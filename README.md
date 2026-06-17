# Pipeline by Alex (`pba`)

One unified `pba.yml` compiles into GitHub Actions CI, testing, and deploy
workflows. You describe **what to test**, **when it runs**, and **what deploys
in what order** — `pba generate` writes the `.github/workflows/*.yml` files; a
CI drift gate (`pba check`) keeps the generated files in sync with the source.

## Why generate-and-commit (not a runtime interpreter)

The generated workflows are real, committed files. GitHub branch protection,
required status checks, and the Actions UI all operate on concrete workflow
files and job names — a runtime interpreter would be opaque and unpinnable. The
cost of generation is drift, which the `pba check` gate eliminates: it
regenerates in memory and fails CI if the committed files differ.

## Usage

```bash
pnpm install
pnpm generate          # pba generate  → writes .github/workflows/*.yml
pnpm check             # pba check     → fails if committed files are stale
```

```
pba generate [--config pba.yml] [--out .]
pba check    [--config pba.yml] [--out .]
```

## The model

| Concept       | What it is                                                            | Emits |
|---------------|----------------------------------------------------------------------|-------|
| `components`  | Independently-tested workspaces (a `dir` + `language` + `steps`)      | one CI job each |
| `gates`       | Extra blocking checks (`pnpm-audit`, `prisma-drift`, `command`)       | one CI job each |
| `ci`          | Which branches trigger on push / pull_request                        | the `on:` + concurrency |
| `targets`     | Deploy units defined once (`fly`, `vercel`, `prisma-migrate`, `eas`) | referenced by `deploy` |
| `deploy`      | Per-branch **ordered** list of target names                          | a gated `needs` chain |
| `mobile`      | Independent EAS release (tag + manual dispatch)                       | `eas-build.yml` |

**The deploy `order` IS the `needs` chain.** `order: [fly-prod, migrate-prod,
web-prod]` runs Fly → migrate → Vercel, each gated on the previous, and the
first gated on `needs_ci`. A single red CI/test/gate job blocks the whole chain.

See [`pba.example.yml`](./pba.example.yml) for a full monorepo example (server +
mobile app + python ai-service, Fly + Vercel + Prisma migrations + EAS).

## Modes

**Central / runtime-interpreted (recommended)**: app repos commit a declarative
`pba.yml` + a ~10-line caller; the central reusable workflow
(`.github/workflows/pipeline.yml`) reads the app's `pba.yml` **at runtime** and
runs CI + deploy from it. Nobody generates anything locally. This is the
Bogiefile model — `pba plan` is the interpreter; see
[`docs/runtime-interpreter-plan.md`](./docs/runtime-interpreter-plan.md) and
[`examples/app-repo/`](./examples/app-repo/).

```bash
pba plan [--config pba.yml] [--ref refs/heads/main]   # emit CI matrices + deploy script
```

**Standalone**: `pba` emits full `ci.yml` (+ `eas-build.yml`) with all
jobs inline. Use when a repo owns its own pipeline.

**Central** (add a `central:` block): `pba` emits only a ~10-line *caller* that
delegates to a reusable workflow in a central repo. The pipeline logic lives
once, centrally; this repo carries just the caller. See
[`pba.central.example.yml`](./pba.central.example.yml) and
[`docs/centralized-ci.md`](./docs/centralized-ci.md).

```yaml
central:
  repo: agy/agy-ci          # owner/repo with the reusable workflows
  ref: v1                   # caller pins to this ref (see blast-radius note below)
  bundle: backend-service   # → agy-ci/.github/workflows/backend-service.yml
  with: { fly-app: my-api-prod }
  secrets: inherit
```

### Blast radius / which ref to pin

Only the **central repo** has shared blast radius, and only through a **mutable
ref**: with `ref: v1` (a moving tag) or a branch, moving/pushing it rolls the
change to every caller at once — so gate the central repo with its own CI
(actionlint) before moving the tag. Pin a full version (`v1.2.0`) or SHA for
zero fleet-wide risk; each repo then upgrades on its own by bumping `central.ref`.
`pba check` warns when `ref` is mutable. (`pba` itself is a build-time tool — if
it breaks, you just can't regenerate locally; running CI is unaffected.)

## Vercel: making CI failures actually block a deploy

Vercel's native Git integration deploys on **every push, in parallel with CI** —
it doesn't know or care whether your tests passed. Branch protection only gates
*merges*, not Vercel's reaction to the resulting commit. So by default a red
test suite can't stop a Vercel deploy.

To make "CI red ⇒ no deploy" real, take deploy authority away from Vercel and
give it to CI:

1. **Disable Vercel's auto Git deploy** for the deploying branch — in
   `vercel.json`:
   ```json
   { "git": { "deploymentEnabled": { "main": false } } }
   ```
2. **Let CI own the deploy** with `mode: cli` (the default). `pba` emits a
   `vercel pull/build/deploy` job that sits at the end of the `needs` chain, so
   it physically cannot run unless every CI/test/gate job is green.

`mode: git-integration` is still available, but it is **not gated** — `pba`
emits only a post-hoc health probe and warns you at validation time. Required
secrets for `mode: cli`: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`.

## Secrets the generated workflows expect

| Target           | Secrets / vars |
|------------------|----------------|
| `fly`            | `FLY_API_TOKEN` |
| `vercel` (cli)   | `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` |
| `prisma-migrate` | `<ENV>_DATABASE_URL`, `<ENV>_DIRECT_URL` (e.g. `PRODUCTION_DATABASE_URL`) |
| `eas` / mobile   | `EXPO_TOKEN` |

GitHub Environments named in `environment:` (e.g. `production`) are where you
attach required reviewers and scope these secrets.
