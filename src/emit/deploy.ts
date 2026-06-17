import type { Config, DeployBranch, Target } from "../schema.js";
import {
  checkoutStep,
  EXPO_ACTION,
  healthProbe,
  type Job,
  postgresService,
  runStep,
  SETUP_NODE,
  setupNodeSteps,
} from "./helpers.js";

// ---------------------------------------------------------------------------
// Per-branch deploy chains. The `order` array IS the needs chain: each target
// `needs` the one before it, and the first target `needs` the branch's CI
// gates. So a single red CI/test/gate job blocks the entire chain — including
// Vercel (in cli mode), which is the whole point.
// ---------------------------------------------------------------------------

export function emitDeployJobs(config: Config): Record<string, Job> {
  const jobs: Record<string, Job> = {};

  // A target referenced by more than one branch needs distinct jobs (each has
  // its own `if`), so namespace those by branch. Otherwise keep the bare name.
  const usage = new Map<string, string[]>();
  for (const [branch, dep] of Object.entries(config.deploy)) {
    for (const t of dep.order) usage.set(t, [...(usage.get(t) ?? []), branch]);
  }
  const jobId = (branch: string, target: string): string =>
    (usage.get(target)?.length ?? 0) > 1 ? `${branch}-${target}` : target;

  for (const [branch, dep] of Object.entries(config.deploy)) {
    const cond = branchCondition(branch, dep);
    let prev: string | null = null;

    dep.order.forEach((targetName, idx) => {
      const target = config.targets[targetName];
      if (!target) return; // already flagged in validation
      const id = jobId(branch, targetName);
      const needs = idx === 0 ? dep.needs_ci : prev ? [prev] : [];
      jobs[id] = buildTargetJob(target, { branch, cond, needs, config });
      prev = id;
    });

    // Optional trailing verify probe gated on the whole chain.
    if (dep.verify && prev) {
      jobs[`verify-${branch}`] = {
        name: `Verify ${branch} deploy`,
        "runs-on": config.defaults.runner,
        if: cond,
        needs: [prev],
        steps: [runStep("Health probe", healthProbe(dep.verify, 5, 5))],
      };
    }
  }

  return jobs;
}

function branchCondition(branch: string, dep: DeployBranch): string {
  if (dep.on === "pull_request") {
    return `github.event_name == 'pull_request' && github.base_ref == '${branch}'`;
  }
  return `github.event_name == 'push' && github.ref == 'refs/heads/${branch}'`;
}

interface Ctx {
  branch: string;
  cond: string;
  needs: string[];
  config: Config;
}

function buildTargetJob(target: Target, ctx: Ctx): Job {
  switch (target.type) {
    case "fly":
      return flyJob(target, ctx);
    case "vercel":
      return vercelJob(target, ctx);
    case "prisma-migrate":
      return migrateJob(target, ctx);
    case "eas":
      return easDeployJob(target, ctx);
  }
}

function base(name: string, ctx: Ctx, env?: string): Job {
  const job: Job = {
    name,
    "runs-on": ctx.config.defaults.runner,
    if: ctx.cond,
    steps: [],
  };
  if (ctx.needs.length) job.needs = ctx.needs;
  if (env) job.environment = env;
  return job;
}

// ---- Fly (docker remote-only) ---------------------------------------------

function flyJob(t: Extract<Target, { type: "fly" }>, ctx: Ctx): Job {
  const job = base(`Deploy ${t.app} to Fly`, ctx, t.environment);
  job.env = { FLY_API_TOKEN: "${{ secrets.FLY_API_TOKEN }}", FLY_APP: t.app };
  job.concurrency = { group: `deploy-fly-${t.app}`, "cancel-in-progress": false };
  job.steps = [
    checkoutStep(),
    runStep(
      "Deploy to Fly",
      [
        "set -euo pipefail",
        'if [ -z "${FLY_API_TOKEN:-}" ]; then',
        '  echo "FLY_API_TOKEN secret is not set."; exit 1',
        "fi",
        "docker run --rm \\",
        "  -e FLY_API_TOKEN \\",
        '  -v "${PWD}:/workspace" \\',
        `  -w /workspace/${t.dir} \\`,
        "  ghcr.io/superfly/flyctl:latest \\",
        `  deploy --remote-only --config ${t.config} --app "$FLY_APP"`,
      ].join("\n"),
    ),
  ];
  if (t.health !== false) {
    job.steps.push(
      runStep("Probe Fly health", healthProbe(`https://${t.app}.fly.dev${t.health}`)),
    );
  }
  return job;
}

// ---- Vercel ---------------------------------------------------------------

function vercelJob(t: Extract<Target, { type: "vercel" }>, ctx: Ctx): Job {
  // git-integration: NOT gated — Vercel deploys on its own. We can only
  // health-probe whatever it shipped. (validation already warns about this.)
  if (t.mode === "git-integration") {
    const job = base("Verify Vercel deploy (git-integration — not gated)", ctx, t.environment);
    job.steps = [
      runStep(
        "Wait + probe",
        t.health
          ? `# Vercel auto-deploys on push; this only verifies, it does not gate.\n${healthProbe(t.health, 10, 10)}`
          : 'echo "No health URL set; nothing to verify."',
      ),
    ];
    return job;
  }

  // cli: CI owns the deploy. Gated by `needs`, so red CI blocks it.
  const env = t.environment ?? (t.prod ? "production" : "preview");
  const job = base(`Deploy to Vercel (${t.prod ? "prod" : "preview"})`, ctx, t.environment);
  job.env = {
    VERCEL_TOKEN: "${{ secrets.VERCEL_TOKEN }}",
    VERCEL_ORG_ID: "${{ secrets.VERCEL_ORG_ID }}",
    VERCEL_PROJECT_ID: "${{ secrets.VERCEL_PROJECT_ID }}",
  };
  job.concurrency = { group: `deploy-vercel-${ctx.branch}`, "cancel-in-progress": false };
  const flag = t.prod ? "--prod " : "";
  const vercelEnv = t.prod ? "production" : "preview";
  job.steps = [
    checkoutStep(),
    {
      name: "Setup Node",
      uses: SETUP_NODE,
      with: { "node-version": ctx.config.defaults.node },
    },
    runStep("Install Vercel CLI", "npm install --global vercel@latest"),
    runStep("Pull Vercel env", `vercel pull --yes --environment=${vercelEnv} --token=$VERCEL_TOKEN`, {
      dir: t.dir,
    }),
    runStep("Build", `vercel build ${flag}--token=$VERCEL_TOKEN`, { dir: t.dir }),
    runStep("Deploy", `vercel deploy --prebuilt ${flag}--token=$VERCEL_TOKEN`, { dir: t.dir }),
  ];
  if (t.health) {
    job.steps.push(runStep("Probe app health", healthProbe(t.health, 5, 5)));
  }
  return job;
}

// ---- Prisma migrate -------------------------------------------------------

function migrateJob(t: Extract<Target, { type: "prisma-migrate" }>, ctx: Ctx): Job {
  const prefix = t.environment ? `${t.environment.toUpperCase()}_` : "";
  const dbEnv = {
    DATABASE_URL: `\${{ secrets.${prefix}DATABASE_URL }}`,
    DIRECT_URL: `\${{ secrets.${prefix}DIRECT_URL }}`,
  };
  const job = base("Migrate database", ctx, t.environment);
  job.services = { shadow: postgresService("postgres:16", "shadow") };
  job.concurrency = { group: `migrate-${ctx.branch}`, "cancel-in-progress": false };
  job.steps = [
    checkoutStep(),
    ...setupNodeSteps(t.dir, ctx.config.defaults),
    runStep("Install deps", "pnpm install --frozen-lockfile", { dir: t.dir }),
    runStep("Apply migrations", "pnpm run db:migrate:deploy", { dir: t.dir, env: dbEnv }),
    runStep("Verify migration status", "pnpm run db:migrate:status", { dir: t.dir, env: dbEnv }),
  ];
  if (t.health) {
    job.steps.push(runStep("Post-migration health smoke", healthProbe(t.health, 5, 5)));
  }
  return job;
}

// ---- EAS as an ordered deploy step ----------------------------------------

function easDeployJob(t: Extract<Target, { type: "eas" }>, ctx: Ctx): Job {
  const job = base(`EAS build (${t.platform}, ${t.profile})`, ctx, t.environment);
  job.steps = [
    checkoutStep(),
    ...setupNodeSteps(t.dir, ctx.config.defaults),
    {
      name: "Setup EAS",
      uses: EXPO_ACTION,
      with: { "eas-version": "^13", token: "${{ secrets.EXPO_TOKEN }}", packager: "pnpm" },
    },
    runStep("Install deps", "pnpm install --frozen-lockfile", { dir: t.dir }),
    runStep(
      "Run EAS build",
      `eas build --non-interactive --no-wait --profile "$PROFILE" --platform "$PLATFORM"`,
      { dir: t.dir, env: { PROFILE: t.profile, PLATFORM: t.platform } },
    ),
  ];
  return job;
}
