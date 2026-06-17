# Plan: `pba.yml` as a runtime-interpreted Bogiefile

> Status: **design / not built yet.** This captures the agreed architecture so we
> can implement it later. The current code in `src/` only does local
> generation (`pba generate` / `pba check`); the model below replaces that as
> the primary flow.

## Goal

Each app repo commits a real **`pba.yml`** (the declarative "Bogiefile") plus a
tiny caller. **Nobody generates anything locally.** GitHub runs the caller,
which calls a central reusable workflow in **`pipelinebyalex`**; that workflow
checks out the app repo, **reads its `pba.yml` at runtime**, and runs the
pipeline from it.

This sidesteps "GitHub can't parse a custom `pba.yml`": GitHub doesn't — the
**central workflow does** (it runs `pba`). It's the Capital One Bogiefile model,
where `pipelinebyalex` is the platform that interprets the file.

```
App repo (e.g. nisatsu)                 Central repo (pipelinebyalex)
─────────────────────────               ─────────────────────────────
pba.yml            ← declarative        .github/workflows/pipeline.yml  (reusable)
.github/workflows/                       src/  (the pba interpreter)
  ci.yml           ← tiny caller ───────► reads the app's pba.yml at runtime
package.json, tests, etc.
```

## The one GitHub constraint to design around

A workflow's **jobs are static**, but **matrix entries are dynamic**
(`strategy.matrix: ${{ fromJSON(...) }}`). So we can't generate arbitrary jobs
at runtime, but we *can*:

1. Run a `plan` job that executes `pba` to emit a JSON matrix + a deploy script.
2. Have fixed `test` / `gates` / `deploy` jobs fan out from that plan.

This keeps **real parallel jobs**, per-component logs, and **"red CI blocks
deploy"** — all driven by the app's `pba.yml`.

## Component 1 — new `pba plan` command (the interpreter)

`pba plan --config pba.yml --ref "$GITHUB_REF"` reads the config and writes to
`$GITHUB_OUTPUT` (or stdout):

- `components` — JSON array, one entry per component, each:
  ```jsonc
  {
    "id": "server",
    "setup": "node",            // node | python | none (docker python = none)
    "node": "24",
    "python": "3.11",
    "runner": "ubuntu-latest",  // string only in v1 (array/self-hosted = later)
    "cache_path": "server/pnpm-lock.yaml",
    "needs_db": false,
    "script": "set -euo pipefail\ncd server\npnpm install --frozen-lockfile\npnpm run typecheck\npnpm run lint\npnpm test"
  }
  ```
- `gates` — same shape (pnpm-audit / prisma-drift / command), with `needs_db`
  true for prisma-drift.
- `deploy_enabled` — `"true"`/`"false"` for whether `--ref` matches a
  `deploy.<branch>` push ref.
- `deploy_environment` — the GitHub Environment to bind the deploy job to
  (first non-empty target environment; see tradeoff below).
- `deploy_script` — the ordered deploy chain for the ref as one shell script
  (fly → migrate → vercel → eas, in `deploy.<branch>.order`), written via a
  heredoc because it's multiline.

**Key idea:** the *scripts are embedded in the plan*, so only the `plan` job
needs the `pba` tool — the fan-out jobs just run `${{ matrix.component.script }}`
and need no tool/checkout of `pipelinebyalex`.

Script builders to write (reuse the command knowledge already in
`src/emit/helpers.ts`, `ci.ts`, `deploy.ts`, but emit shell strings instead of
step objects):

- node component: `cd <dir>` then `pnpm install` / `db:generate` / `typecheck` /
  `lint` / `test` per `steps` (inline `export KEY=val` for `env.test`).
- python docker: `docker build --target … && docker run --rm …:test`.
- python plain: `pip install -e '.[dev]'` then `ruff` / `mypy` / `pytest`.
- pnpm-audit gate: retry loop `pnpm audit --prod --audit-level <level>` per dir.
- prisma-drift gate: `pnpm run db:migrate:drift-check` with `SHADOW_DATABASE_URL`.
- command gate: optional setup + the raw `run`.
- deploy targets: fly (flyctl docker), vercel (cli pull/build/deploy), migrate
  (`db:migrate:deploy` + `:status`), eas (`eas build --no-wait`).

CLI: add `case "plan"` in `src/index.ts`; new module `src/plan.ts`; a
`writeOutput(name, value)` helper that handles `$GITHUB_OUTPUT` heredoc vs
stdout.

## Component 2 — central reusable workflow

`pipelinebyalex/.github/workflows/pipeline.yml`:

```yaml
name: pba pipeline
on:
  workflow_call:
    inputs:
      pba_ref: { type: string, default: "v1" }   # which pipelinebyalex ref to run
    # secrets: inherited from the caller (no need to declare with `inherit`)

jobs:
  plan:
    runs-on: ubuntu-latest
    outputs:
      components: ${{ steps.p.outputs.components }}
      gates: ${{ steps.p.outputs.gates }}
      deploy_enabled: ${{ steps.p.outputs.deploy_enabled }}
      deploy_environment: ${{ steps.p.outputs.deploy_environment }}
      deploy_script: ${{ steps.p.outputs.deploy_script }}
    steps:
      - uses: actions/checkout@v4                       # the APP repo (caller) — has pba.yml
      - uses: actions/checkout@v4                       # the pba tool
        with: { repository: AGY-LLC/pipelinebyalex, ref: ${{ inputs.pba_ref }}, path: .pba-tool }
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - working-directory: .pba-tool
        run: pnpm install --frozen-lockfile
      - id: p
        run: node .pba-tool/bin/pba.mjs plan --config pba.yml --ref "$GITHUB_REF"

  test:
    needs: plan
    if: ${{ needs.plan.outputs.components != '[]' }}
    strategy:
      fail-fast: false
      matrix:
        component: ${{ fromJSON(needs.plan.outputs.components) }}
    runs-on: ${{ matrix.component.runner }}
    services:
      postgres:                                         # always available for tests that need it
        image: postgres:16
        env: { POSTGRES_USER: postgres, POSTGRES_PASSWORD: postgres, POSTGRES_DB: app_test }
        ports: ["5432:5432"]
        options: >-
          --health-cmd="pg_isready -U postgres" --health-interval=10s
          --health-timeout=5s --health-retries=5
    env:
      DATABASE_URL: postgresql://postgres:postgres@localhost:5432/app_test
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        if: ${{ matrix.component.setup == 'node' }}
      - uses: actions/setup-node@v4
        if: ${{ matrix.component.setup == 'node' }}
        with:
          node-version: ${{ matrix.component.node }}
          cache: pnpm
          cache-dependency-path: ${{ matrix.component.cache_path }}
      - uses: actions/setup-python@v5
        if: ${{ matrix.component.setup == 'python' }}
        with: { python-version: ${{ matrix.component.python }} }
      - run: ${{ matrix.component.script }}

  gates:
    needs: plan
    if: ${{ needs.plan.outputs.gates != '[]' }}
    strategy: { fail-fast: false, matrix: { gate: ${{ fromJSON(needs.plan.outputs.gates) }} } }
    runs-on: ${{ matrix.gate.runner }}
    services:
      postgres:                                         # shadow DB for prisma-drift
        image: postgres:16
        env: { POSTGRES_USER: postgres, POSTGRES_PASSWORD: postgres, POSTGRES_DB: shadow }
        ports: ["5432:5432"]
        options: >-
          --health-cmd="pg_isready -U postgres" --health-interval=10s
          --health-timeout=5s --health-retries=5
    env:
      SHADOW_DATABASE_URL: postgresql://postgres:postgres@localhost:5432/shadow
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        if: ${{ matrix.gate.setup == 'node' }}
      - uses: actions/setup-node@v4
        if: ${{ matrix.gate.setup == 'node' }}
        with: { node-version: ${{ matrix.gate.node }}, cache: pnpm, cache-dependency-path: ${{ matrix.gate.cache_path }} }
      - uses: actions/setup-python@v5
        if: ${{ matrix.gate.setup == 'python' }}
        with: { python-version: ${{ matrix.gate.python }} }
      - run: ${{ matrix.gate.script }}

  deploy:
    needs: [plan, test, gates]
    # waits for CI, runs only if the ref deploys AND nothing failed
    if: ${{ always() && needs.plan.outputs.deploy_enabled == 'true'
            && needs.test.result != 'failure' && needs.gates.result != 'failure' }}
    runs-on: ubuntu-latest
    environment: ${{ needs.plan.outputs.deploy_environment }}
    env:
      FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
      VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
      VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
      VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
      EXPO_TOKEN: ${{ secrets.EXPO_TOKEN }}
      DATABASE_URL: ${{ secrets.DATABASE_URL }}   # from the bound Environment's secrets
      DIRECT_URL: ${{ secrets.DIRECT_URL }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: ${{ needs.plan.outputs.deploy_script }}
```

## Component 3 — the app-repo caller (the whole per-repo footprint)

```yaml
# <app-repo>/.github/workflows/ci.yml
name: CI
on:
  push: { branches: [main, staging] }
  pull_request:
jobs:
  ci:
    uses: AGY-LLC/pipelinebyalex/.github/workflows/pipeline.yml@v1
    secrets: inherit
```

Plus the app repo's real `pba.yml` (components/gates/ci/targets/deploy as today).

## Secrets model

- Use **`secrets: inherit`** in the caller; define `FLY_API_TOKEN`,
  `VERCEL_*`, `EXPO_TOKEN` as **org secrets**.
- Put **`DATABASE_URL` / `DIRECT_URL` as GitHub *Environment* secrets**
  (per `staging` / `production` environment), not prefixed names. The deploy job
  binds `environment:` and gets the right value automatically. This is why the
  deploy script uses unprefixed `DATABASE_URL` (change from the current
  generator, which emits `STAGING_DATABASE_URL` etc.).

## Known v1 tradeoffs (write these down so they're not surprises)

1. **One environment per branch deploy.** The deploy chain runs as a single
   ordered job, so it gets one `environment:` approval for the whole chain, not
   per-target. Per-target approval would need separate static jobs.
2. **Dynamic steps aren't possible** — only dynamic *jobs* (matrix). That's why
   each component runs as one embedded `script` rather than discrete GitHub
   steps. Trade: less granular step UI; gain: fully dynamic from `pba.yml`.
3. **`runner` is a string in v1.** Array labels (self-hosted/macOS) via matrix
   need extra handling (`fromJSON` on `runs-on`). Add later for the iOS runner.
4. **`pba` runs via `tsx` in the `plan` job.** Fine, but a built/published CLI
   (or `npx pipelinebyalex@1`) would be faster and remove the second checkout.
5. **Services are fixed** (one postgres on test, one on gates). Components that
   need other services aren't covered yet.

## Implementation checklist

- [ ] `src/plan.ts`: build the plan object (components, gates, deploy) from a
      `Config` + `ref`; shell-script builders per component/gate/target.
- [ ] `writeOutput()` helper (GITHUB_OUTPUT heredoc vs stdout).
- [ ] `src/index.ts`: add `plan` command (`--ref`, `--config`).
- [ ] Switch deploy DB env to unprefixed `DATABASE_URL`/`DIRECT_URL`.
- [ ] `.github/workflows/pipeline.yml`: the reusable workflow above.
- [ ] `examples/callers/app-ci.yml`: the tiny caller.
- [ ] Tests for `pba plan` output shape (valid JSON, correct scripts, deploy
      gating by ref).
- [ ] Decide fate of `pba generate`/`check`: keep as an optional standalone
      escape hatch, or remove once the interpreter is the default.
- [ ] Publish `pba` to npm (optional) to drop the in-workflow checkout+install.

## Relationship to current code

- Keep: `src/schema.ts` (the `pba.yml` parser/validator) — reused as-is.
- Reuse the command strings in `src/emit/*` to build the plan scripts.
- `central` mode (`src/emit/caller.ts`) becomes unnecessary under this model
  (the caller is hand-written/templated, not generated), but is harmless to
  leave for the generate-based workflow.
