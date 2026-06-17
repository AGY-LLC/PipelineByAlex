# Centralized GitHub Actions CI/CD with reusable workflows

How to run CI/CD for many repos (web, mobile, backend, fullstack) from **one
central place**, without copying full YAML into every repo. Opinionated for a
solo dev / small startup that still wants to scale to many repos.

---

## 1. Recommended architecture

```
┌─────────────────────────────┐
│  agy-ci  (one central repo)  │   ← the ONLY place real pipeline logic lives
│  .github/workflows/          │
│    node-test.yml   (reusable)│
│    deploy-fly.yml  (reusable)│
│    web-app.yml     (reusable bundle)
│    ...                       │
└─────────────────────────────┘
            ▲  uses: agy/agy-ci/.github/workflows/web-app.yml@v1
            │
   ┌────────┴─────────┬──────────────────┬─────────────────┐
   │  repo: marketing │  repo: api        │  repo: mobile   │
   │  ci.yml (caller) │  ci.yml (caller)  │  ci.yml (caller)│  ← ~10 lines each
   └──────────────────┴───────────────────┴─────────────────┘
```

Three rules that make this scale:

1. **One dedicated `agy-ci` repo** for reusable workflows — not the special
   `.github` repo (that's for *starter templates*, which are copy-scaffolds —
   the opposite of DRY; see §4).
2. **Create a GitHub Organization**, even solo. Free, and it unlocks the three
   things centralization actually needs: **org-level secrets**, **runner
   groups** (your future mac runner), and **required-workflow rulesets**.
3. **Pin callers to a moving major tag** (`@v1`), not `@main`. A bad push to
   `main` would break CI in *every* repo at once. Tag `v1` and move it forward
   as you ship non-breaking changes (or use full semver + Dependabot).

---

## 2. Why each repo still needs a small caller file

GitHub Actions **only discovers and triggers workflows from
`.github/workflows/*.yml` on the repo being pushed.** It never reaches into
another repo to find a pipeline, and never parses a custom root file. A
reusable workflow uses `on: workflow_call`, which **cannot be triggered by a
push/PR directly** — it can only be *called*.

So each repo needs a tiny file that: (a) owns the **trigger**
(`on: push`/`pull_request` — must be local), and (b) delegates the **logic**
via `uses:`. ~10 lines, basically never changes. The real logic stays in
`agy-ci`.

---

## 3. How `on: workflow_call` works

A reusable workflow declares a typed interface, like a function signature:

```yaml
on:
  workflow_call:
    inputs:
      working-directory: { type: string,  default: "." }
      node-version:      { type: string,  default: "22" }
      run-lint:          { type: boolean, default: true }
    secrets:
      NPM_TOKEN: { required: false }
```

A caller invokes it at the **job** level with `uses:` (not `steps:`):

```yaml
jobs:
  test:
    uses: agy/agy-ci/.github/workflows/node-test.yml@v1
    with:        # → inputs
      working-directory: app
    secrets: inherit   # → secrets
```

Mechanics & limits:

- `@ref` can be a branch, tag, or SHA. Use a tag or SHA for safety.
- A job that calls a reusable workflow **can only** have `uses`, `with`,
  `secrets`, `needs`, `if`, `strategy`, `permissions` — **no `steps`**. The
  called workflow *is* the job body.
- Input types are only `string`, `boolean`, `number` (no `choice` — that's
  `workflow_dispatch`-only).
- Chain with `needs:` to build a deploy-order gate across reusable jobs.
- Nesting depth up to **4 levels**; one caller can reference up to **20**
  reusable workflows.

---

## 4. Reusable workflows vs starter templates vs required workflows/rulesets

| | What it is | DRY? | Lives in |
|---|---|---|---|
| **Reusable workflow** | Logic *linked* and executed via `uses:`. Fix once, all callers get it. | ✅ this is what you want | `agy-ci/.github/workflows/` |
| **Starter template** | A scaffold shown in the "New workflow" UI, **copied** into a repo; each copy then drifts. | ❌ one-time copy | the `.github` repo, `workflow-templates/` |
| **Required workflows / rulesets** | An org *policy* forcing a workflow to run+pass before merge across repos. Enforcement, not logic. | n/a | Org → Settings → Rules → Rulesets |

Opinion: **reusable workflows for logic, skip starter templates** (they
reintroduce duplication), add a **ruleset requiring your `agy-ci` CI** once on
an org. ("Required workflows" is now folded into **repository rulesets** →
"Require workflows to pass before merging," an org/Team feature.) On a personal
account, fall back to per-repo branch-protection required status checks.

---

## 5. Example folder structure for `agy-ci`

```
agy-ci/
  README.md
  .github/
    workflows/
      # ── building blocks (each does ONE thing) ──
      node-test.yml          # install + lint + typecheck + test (node)
      python-test.yml        # ruff + mypy + pytest
      docker-build.yml       # build (+ optional Trivy scan)
      deploy-fly.yml         # fly deploy + health probe
      deploy-vercel.yml      # vercel pull/build/deploy (gated)
      eas-build.yml          # mobile EAS build
      ios-maestro.yml        # iOS UI tests on a macOS runner
      # ── bundles (compose blocks per repo TYPE) ──
      web-app.yml            # node-test → deploy-vercel
      backend-service.yml    # node/python-test → docker-build → deploy-fly → migrate
      mobile-app.yml         # node-test → eas-build → ios-maestro
```

Building blocks are reused everywhere; bundles are per-type one-liners so a
repo's caller is a single `uses:`. (Bundles calling blocks = nested reusable
workflows, allowed up to 4 deep.)

Ready-to-use copies of these files live in
[`examples/agy-ci/`](../examples/agy-ci/).

---

## 6. Example reusable workflow

See [`examples/agy-ci/.github/workflows/deploy-fly.yml`](../examples/agy-ci/.github/workflows/deploy-fly.yml)
and the bundle
[`backend-service.yml`](../examples/agy-ci/.github/workflows/backend-service.yml).
Key idea — parameterized `runs-on`, declared secrets, and the `needs:` gate so
**CI must pass before deploy**.

---

## 7. Example per-repo caller

The entire `.github/workflows/ci.yml` in a backend repo:

```yaml
name: CI
on:
  push:         { branches: [main, staging] }
  pull_request: { branches: [main, staging] }

jobs:
  pipeline:
    uses: agy/agy-ci/.github/workflows/backend-service.yml@v1
    with:
      fly-app: my-api-prod
    secrets: inherit
```

A web repo uses `web-app.yml@v1`; mobile uses `mobile-app.yml@v1`. See
[`examples/agy-ci/callers/`](../examples/agy-ci/callers/).

---

## 8. Passing inputs and secrets

- **Inputs** → `with:` in the caller, read as `${{ inputs.x }}` in the reusable
  workflow. Typed and validated.
- **Secrets**, two ways:
  - **`secrets: inherit`** — passes every secret the caller can see (org +
    repo + environment). Best for solo/small team: define `FLY_API_TOKEN`,
    `VERCEL_TOKEN`, `EXPO_TOKEN` **once as org secrets**, scope to repos, never
    wire again.
  - **Explicit** — `secrets: { FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }} }`
    for least-privilege per call.
- A reusable workflow can't read `secrets.*` unless the secret is **declared**
  under `on.workflow_call.secrets` or passed via `inherit`.
- For approvals/scoped creds, set `environment:` on the deploy job — that's
  where required reviewers and environment secrets attach.

**Recommendation:** org secrets + `secrets: inherit`. Biggest single reduction
in per-repo toil.

---

## 9. Supporting different repo types

Don't build one mega-workflow with a `type` switch — it becomes an `if:`
tangle. Use **small single-purpose blocks + one bundle per type**:

| Repo type | Caller uses | Composes |
|---|---|---|
| Web | `web-app.yml` | node-test → deploy-vercel |
| Backend | `backend-service.yml` | node/python-test → docker-build → deploy-fly → migrate |
| Mobile | `mobile-app.yml` | node-test → eas-build → ios-maestro |
| Fullstack | `web-app.yml` **and** `backend-service.yml` as two jobs (or a `fullstack.yml` bundle) | both chains, gated per surface |

New repo of a known type = one `uses:` line. New capability = edit one block in
`agy-ci`; every repo inherits it on the next `v1` move.

---

## 10. Self-hosted macOS runner for iOS / Maestro

iOS UI tests need a real macOS host with Xcode + the iOS Simulator;
`ubuntu-latest` can't do it.

1. **Register the runner at the org level**, in a **runner group** scoped to
   your mobile repos, with labels like `[self-hosted, macOS, ios]`. (Org +
   runner groups is why you want an org; a repo-level runner can't be shared.)
2. **Parameterize `runs-on`** so only the iOS job targets the mac; everything
   else stays on free Ubuntu:

```yaml
on:
  workflow_call:
    inputs:
      runner: { type: string, default: "ubuntu-latest" }
jobs:
  ui-test:
    runs-on: ${{ fromJSON(inputs.runner) }}   # pass '["self-hosted","macOS","ios"]'
    steps:
      - uses: actions/checkout@v4
      - run: curl -Ls https://get.maestro.mobile.dev | bash
      - run: xcrun simctl boot "iPhone 15" || true
      - run: maestro test .maestro/
```

The mobile caller passes `runner: '["self-hosted","macOS","ios"]'`. Web/backend
repos never touch the mac.

**Security:** self-hosted runners + **public** repos is dangerous (fork PRs can
run code on your machine). Keep mac-runner repos **private**, or gate with
`pull_request_target` + manual approval.

---

## How this relates to `pba`

This "one place for logic, thin wrapper per repo" model *is* the
reusable-workflow pattern. `pba` keeps a clean role: instead of generating full
CI files, have **`pba generate` emit the ~10-line caller** from `pba.yml`, while
the heavy logic lives in `agy-ci` reusable workflows. You get declarative
single-file authoring **and** GitHub-native centralization — and no drift
problem, because the caller is trivial and stable.
