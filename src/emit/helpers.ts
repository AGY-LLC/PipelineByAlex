import type { Component, Defaults } from "../schema.js";

// Loose object types for the workflow YAML we emit. The `yaml` package
// serializes plain objects; we keep insertion order meaningful.
export type Step = Record<string, unknown>;
export interface Job {
  name: string;
  "runs-on": string | string[];
  if?: string;
  needs?: string[];
  environment?: string;
  permissions?: Record<string, string>;
  services?: Record<string, unknown>;
  concurrency?: { group: string; "cancel-in-progress": boolean };
  "timeout-minutes"?: number;
  env?: Record<string, string>;
  steps: Step[];
}
// A job that delegates to a reusable workflow (`uses:` at the job level).
export interface CallerJob {
  name?: string;
  uses: string;
  if?: string;
  needs?: string[];
  with?: Record<string, string | number | boolean>;
  secrets?: "inherit" | Record<string, string>;
}

export interface Workflow {
  name: string;
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, Job | CallerJob>;
}

/** Reorder a job's keys into a conventional, readable order for emission. */
export function orderJobKeys(job: Job): Job {
  const order: (keyof Job)[] = [
    "name",
    "runs-on",
    "if",
    "needs",
    "environment",
    "permissions",
    "concurrency",
    "timeout-minutes",
    "env",
    "services",
    "steps",
  ];
  const out: Record<string, unknown> = {};
  for (const k of order) if (job[k] !== undefined) out[k] = job[k];
  return out as unknown as Job;
}

export const CHECKOUT = "actions/checkout@v4";
export const SETUP_NODE = "actions/setup-node@v4";
export const SETUP_PNPM = "pnpm/action-setup@v4";
export const SETUP_PYTHON = "actions/setup-python@v5";
export const EXPO_ACTION = "expo/expo-github-action@v8";
export const UPLOAD_ARTIFACT = "actions/upload-artifact@v4";

export function checkoutStep(opts?: { fetchDepth?: number }): Step {
  const step: Step = { uses: CHECKOUT };
  if (opts?.fetchDepth !== undefined) step.with = { "fetch-depth": opts.fetchDepth };
  return step;
}

/** pnpm/action-setup + setup-node with pnpm cache scoped to a workspace. */
export function setupNodeSteps(dir: string, defaults: Defaults): Step[] {
  const pnpmSetup: Step = { name: "Setup pnpm", uses: SETUP_PNPM };
  // Only pass `version` when pinned; otherwise action-setup reads
  // packageManager from package.json (passing both errors with
  // ERR_PNPM_BAD_PM_VERSION).
  if (defaults.pnpm !== undefined) pnpmSetup.with = { version: String(defaults.pnpm) };

  return [
    pnpmSetup,
    {
      name: "Setup Node",
      uses: SETUP_NODE,
      with: {
        "node-version": defaults.node,
        cache: "pnpm",
        "cache-dependency-path": `${dir}/pnpm-lock.yaml`,
      },
    },
  ];
}

export function setupPythonStep(version: string): Step {
  return {
    name: "Setup Python",
    uses: SETUP_PYTHON,
    with: { "python-version": version, cache: "pip" },
  };
}

/** A `run` step scoped to a working directory, optionally with env. */
export function runStep(
  name: string,
  run: string,
  opts?: { dir?: string; env?: Record<string, string> },
): Step {
  const step: Step = { name };
  if (opts?.dir) step["working-directory"] = opts.dir;
  if (opts?.env && Object.keys(opts.env).length) step.env = opts.env;
  step.run = run;
  return step;
}

/** Throwaway Postgres service container (shared by drift + db-needing tests). */
export function postgresService(image = "postgres:16", db = "shadow"): Record<string, unknown> {
  return {
    image,
    env: {
      POSTGRES_USER: "postgres",
      POSTGRES_PASSWORD: "postgres",
      POSTGRES_DB: db,
    },
    ports: ["5432:5432"],
    options: [
      '--health-cmd="pg_isready -U postgres"',
      "--health-interval=10s",
      "--health-timeout=5s",
      "--health-retries=5",
    ].join(" "),
  };
}

/** Bounded retry wrapper for a flaky network command (mirrors the examples). */
export function withRetry(cmd: string, attempts = 3, delay = 30): string {
  return [
    `for attempt in 1 2 3; do`,
    `  ${cmd} && exit 0`,
    `  [ "$attempt" = ${attempts} ] && exit 1`,
    `  echo "command failed (attempt \${attempt}/${attempts}); retrying in ${delay}s" >&2`,
    `  sleep ${delay}`,
    `done`,
  ].join("\n");
}

/** curl health probe with retry/backoff. */
export function healthProbe(url: string, retries = 10, delay = 6): string {
  return `set -euo pipefail\ncurl -fsSL --retry ${retries} --retry-delay ${delay} --max-time 10 "${url}"`;
}

/** Map a node step name to its pnpm command. */
export function nodeStepCommand(step: string): { name: string; run: string } | null {
  switch (step) {
    case "install":
      return { name: "Install deps", run: "pnpm install --frozen-lockfile" };
    case "prisma-generate":
      return { name: "Generate Prisma client", run: "pnpm run db:generate" };
    case "typecheck":
      return { name: "Typecheck", run: "pnpm run typecheck" };
    case "lint":
      return { name: "Lint", run: "pnpm run lint" };
    case "test":
      return { name: "Test", run: "pnpm test" };
    case "build":
      return { name: "Build", run: "pnpm run build" };
    default:
      return null;
  }
}

/** Map a python step name to its command. */
export function pythonStepCommand(step: string): { name: string; run: string } | null {
  switch (step) {
    case "install":
      return {
        name: "Install package and dev deps",
        run: "python -m pip install --upgrade pip\npip install -e '.[dev]'",
      };
    case "lint":
      return { name: "Ruff", run: "ruff check ." };
    case "typecheck":
      return { name: "Mypy", run: "mypy" };
    case "test":
      return { name: "Pytest", run: "pytest -q" };
    default:
      return null;
  }
}

export function resolveRunner(component: Component, defaults: Defaults): string | string[] {
  return component.runner ?? defaults.runner;
}
