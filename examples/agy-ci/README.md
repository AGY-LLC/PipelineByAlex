# `agy-ci` — central reusable workflows (example scaffold)

Copy this into a dedicated repo named `agy-ci` under your GitHub org. It holds
**all** the real CI/CD logic; your app repos each carry only a ~10-line caller.

Full write-up: [`../../docs/centralized-ci.md`](../../docs/centralized-ci.md).

## Layout

```
.github/workflows/
  node-test.yml         # block: install + lint + typecheck + test
  deploy-fly.yml        # block: fly deploy + health probe
  deploy-vercel.yml     # block: gated vercel CLI deploy
  eas-build.yml         # block: mobile EAS build
  ios-maestro.yml       # block: iOS UI tests on a macOS runner
  backend-service.yml   # bundle: test → deploy-fly
  web-app.yml           # bundle: test → deploy-vercel
  mobile-app.yml        # bundle: test → ios-maestro → eas-build
callers/                # copy ONE of these into each app repo as ci.yml
  backend-ci.yml
  web-ci.yml
  mobile-ci.yml
```

## Setup checklist

1. Create a GitHub **Organization** (free) and this **`agy-ci`** repo inside it.
2. Replace `agy/agy-ci` in every `uses:` with your real `org/repo`.
3. Add **org-level secrets** (`FLY_API_TOKEN`, `VERCEL_TOKEN`, `VERCEL_ORG_ID`,
   `VERCEL_PROJECT_ID`, `EXPO_TOKEN`) and scope them to your repos so
   `secrets: inherit` works everywhere.
4. If `agy-ci` is **private**, enable Settings → Actions → General →
   "Accessibility" → allow access from your other repos.
5. Tag a release: `git tag v1 && git push --tags`. Callers pin `@v1`; move the
   `v1` tag forward as you ship non-breaking changes.
6. In each app repo, copy the matching `callers/*.yml` to
   `.github/workflows/ci.yml`.
7. (Optional, org) Add a **ruleset** → "Require workflows to pass before
   merging" to force CI on every repo.
