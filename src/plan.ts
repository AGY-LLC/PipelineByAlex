import type { Component, Config, Gate, SmokeSuite, Target } from "./schema.js";

// ---------------------------------------------------------------------------
// `pba plan` — the runtime interpreter.
//
// Reads a Config + the triggering git ref and produces a "plan": JSON matrices
// of components and gates (each carrying an embedded shell script), plus the
// ordered deploy script for the ref. The central reusable workflow runs this
// once in a `plan` job, then fans out `test`/`gates`/`deploy` jobs from it — so
// the fan-out jobs need no copy of this tool, only the embedded scripts.
// ---------------------------------------------------------------------------

export interface MatrixEntry {
  id: string;
  setup: "node" | "python" | "none";
  node: string;
  python: string;
  runner: string | string[];
  cache_path: string;
  needs_db: boolean;
  // Git checkout depth for this job's checkout. 0 = full history (needed for
  // merge-base / append-only diffs); 1 = shallow (the default).
  fetch_depth: number;
  // GitHub Environment to bind for this job ("" = none). An env-bound gate can
  // read that environment's secrets (e.g. a live-DB preflight).
  environment: string;
  // pnpm version for pnpm/action-setup ("" = let the action read packageManager
  // from package.json — passing both errors with ERR_PNPM_BAD_PM_VERSION).
  pnpm: string;
  script: string;
}

// Context about the triggering event, used to decide which gates apply.
export interface PlanOptions {
  event?: string; // github.event_name: "push" | "pull_request" | ...
  baseRef?: string; // github.base_ref: the PR's target branch (PRs only)
  suite?: string; // run only this smoke suite (empty = all)
}

export interface DeployPlan {
  enabled: boolean;
  environment: string;
  script: string;
  // pnpm version for the deploy job's setup ("" = read packageManager).
  pnpm: string;
}

export interface Plan {
  components: MatrixEntry[];
  gates: MatrixEntry[];
  smoke: MatrixEntry[];
  deploy: DeployPlan;
}

const SH = "set -euo pipefail";

/** The pnpm version to pin in action-setup, or "" to let it read packageManager. */
function pnpmVersion(config: Config): string {
  return config.defaults.pnpm != null ? String(config.defaults.pnpm) : "";
}

function cd(dir: string): string {
  return `cd "${dir}"`;
}

function imageName(dir: string): string {
  if (dir === ".") return "app";
  return dir.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "app";
}

function envExports(env?: Record<string, string>): string[] {
  if (!env) return [];
  return Object.entries(env).map(([k, v]) => `export ${k}="${v}"`);
}

// ---- component scripts ----------------------------------------------------

function nodeComponentScript(comp: Component): string {
  const lines = [SH, cd(comp.dir)];
  for (const step of comp.steps ?? []) {
    switch (step) {
      case "install":
        lines.push("pnpm install --frozen-lockfile");
        break;
      case "prisma-generate":
        lines.push("pnpm run db:generate");
        break;
      case "typecheck":
        lines.push("pnpm run typecheck");
        break;
      case "lint":
        lines.push("pnpm run lint");
        break;
      case "test":
        lines.push(...envExports(comp.env?.test), "pnpm test");
        break;
      case "build":
        lines.push("pnpm run build");
        break;
    }
  }
  return lines.join("\n");
}

function pythonDockerScript(comp: Component): string {
  const docker = comp.docker!;
  const ctx = docker.context ?? comp.dir;
  const img = imageName(comp.dir);
  const lines = [SH];
  for (const target of docker.targets) {
    lines.push(`docker build --target ${target} -t ${img}:${target} ${ctx}`);
  }
  const testTarget = docker.test ?? (docker.targets.includes("test") ? "test" : undefined);
  if (testTarget) lines.push(`docker run --rm ${img}:${testTarget}`);
  return lines.join("\n");
}

function pythonPlainScript(comp: Component): string {
  const steps = comp.steps ?? [];
  const lines = [SH, cd(comp.dir), "python -m pip install --upgrade pip", "pip install -e '.[dev]'"];
  if (steps.includes("lint")) lines.push("ruff check .");
  if (steps.includes("typecheck")) lines.push("mypy");
  if (steps.includes("test")) lines.push(...envExports(comp.env?.test), "pytest -q");
  return lines.join("\n");
}

function componentEntry(id: string, comp: Component, config: Config): MatrixEntry {
  const runner = comp.runner ?? config.defaults.runner;
  const node = String(config.defaults.node);
  const python = comp.python ?? config.defaults.python;
  const needs_db = !!comp.services?.postgres;

  // Components always check out shallow and bind no environment.
  const common = { fetch_depth: 1, environment: "", pnpm: pnpmVersion(config) };

  if (comp.language === "node") {
    return {
      id,
      setup: "node",
      node,
      python,
      runner,
      cache_path: `${comp.dir}/pnpm-lock.yaml`,
      needs_db,
      ...common,
      script: nodeComponentScript(comp),
    };
  }
  // python
  if (comp.docker) {
    return {
      id,
      setup: "none", // docker is preinstalled on the runner
      node,
      python,
      runner,
      cache_path: "",
      needs_db,
      ...common,
      script: pythonDockerScript(comp),
    };
  }
  return {
    id,
    setup: "python",
    node,
    python,
    runner,
    cache_path: "",
    needs_db,
    ...common,
    script: pythonPlainScript(comp),
  };
}

// ---- gate scripts ---------------------------------------------------------

function gateEntry(id: string, gate: Gate, config: Config): MatrixEntry {
  const runner = config.defaults.runner;
  const node = String(config.defaults.node);
  const python = config.defaults.python;

  // Defaults shared by the typed gates (audit / drift): shallow, no env.
  const common = { fetch_depth: 1, environment: "", pnpm: pnpmVersion(config) };

  if (gate.type === "pnpm-audit") {
    const blocks = gate.dirs.map((dir) =>
      [
        `( ${cd(dir)}`,
        `  for attempt in 1 2 3; do`,
        `    pnpm audit --prod --audit-level ${gate.level} && break`,
        `    [ "$attempt" = 3 ] && exit 1`,
        `    echo "pnpm audit failed (attempt $attempt/3); retrying in 30s" >&2; sleep 30`,
        `  done )`,
      ].join("\n"),
    );
    return {
      id,
      setup: "node",
      node,
      python,
      runner,
      // pnpm audit reads the lockfile but never installs, so no pnpm store
      // exists to cache. Leave cache_path empty so setup-node skips caching —
      // otherwise its post-step fails trying to save a path that doesn't exist.
      cache_path: "",
      needs_db: false,
      ...common,
      script: [SH, ...blocks].join("\n"),
    };
  }

  if (gate.type === "prisma-drift") {
    return {
      id,
      setup: "node",
      node,
      python,
      runner,
      cache_path: `${gate.dir}/pnpm-lock.yaml`,
      needs_db: true,
      ...common,
      script: [SH, cd(gate.dir), "pnpm install --frozen-lockfile", "pnpm run db:migrate:drift-check"].join(
        "\n",
      ),
    };
  }

  // command gate
  const lines = [SH];
  // Node installs: explicit `installs` list (multi-workspace) wins; otherwise
  // the single gate.dir when install is on. Each in a subshell so cwd is local.
  if (gate.setup === "node") {
    const dirs = gate.installs ?? (gate.install ? [gate.dir] : []);
    for (const d of dirs) lines.push(`( ${cd(d)} && pnpm install --frozen-lockfile )`);
  }
  // The check itself runs in gate.dir; python deps install there too.
  const inner: string[] = [];
  if (gate.dir !== ".") inner.push(cd(gate.dir));
  if (gate.setup === "python" && gate.install) {
    inner.push("python -m pip install --upgrade pip", "pip install -e '.[dev]'");
  }
  inner.push(gate.run);
  lines.push(inner.length > 1 ? `( ${inner.join(" && ")} )` : inner[0]!);
  return {
    id,
    setup: gate.setup,
    node,
    python,
    runner,
    cache_path: gate.setup === "node" ? `${gate.dir}/pnpm-lock.yaml` : "",
    needs_db: false,
    fetch_depth: gate.full_history ? 0 : 1,
    environment: gate.environment ?? "",
    pnpm: pnpmVersion(config),
    script: lines.join("\n"),
  };
}

// ---- smoke suites ---------------------------------------------------------

function smokeEntry(id: string, suite: SmokeSuite, config: Config): MatrixEntry {
  const runner = suite.runner;
  const node = String(config.defaults.node);
  const python = config.defaults.python;
  const lines = [SH];
  if (suite.setup === "node" && suite.install) {
    lines.push(`( ${cd(suite.dir)} && pnpm install --frozen-lockfile )`);
  }
  if (suite.setup === "python" && suite.install) {
    lines.push(`( ${cd(suite.dir)} && python -m pip install --upgrade pip && pip install -e '.[dev]' )`);
  }
  const inner: string[] = [];
  if (suite.dir !== ".") inner.push(cd(suite.dir));
  inner.push(...envExports(suite.env));
  inner.push(suite.run);
  // A subshell keeps the cd / exports scoped; a single bare run needs no wrap.
  lines.push(inner.length > 1 ? `(\n  ${inner.join("\n  ")}\n)` : inner[0]!);
  return {
    id,
    setup: suite.setup,
    node,
    python,
    runner,
    cache_path: suite.setup === "node" ? `${suite.dir}/pnpm-lock.yaml` : "",
    needs_db: false,
    fetch_depth: 1,
    environment: suite.environment ?? "",
    pnpm: pnpmVersion(config),
    script: lines.join("\n"),
  };
}

// ---- deploy scripts -------------------------------------------------------

function flyScript(t: Extract<Target, { type: "fly" }>): string {
  const lines = [
    `echo "▶ Deploy ${t.app} to Fly"`,
    `docker run --rm -e FLY_API_TOKEN -v "$PWD:/workspace" -w "/workspace/${t.dir}" \\`,
    `  ghcr.io/superfly/flyctl:latest deploy --remote-only --config ${t.config} --app "${t.app}"`,
  ];
  if (t.health !== false) {
    lines.push(
      `curl -fsSL --retry 10 --retry-delay 6 --max-time 10 "https://${t.app}.fly.dev${t.health}"`,
    );
  }
  return lines.join("\n");
}

function vercelScript(t: Extract<Target, { type: "vercel" }>): string {
  if (t.mode === "git-integration") {
    const lines = [`echo "▶ Vercel (git-integration — not gated by this job)"`];
    if (t.health) {
      lines.push(`curl -fsSL --retry 10 --retry-delay 10 --max-time 10 "${t.health}"`);
    }
    return lines.join("\n");
  }
  // Resolve the deploy target: explicit `target` wins, else the `prod` boolean
  // maps to Vercel's built-in production/preview environments.
  const target = t.target ?? (t.prod ? "production" : "preview");
  const flag =
    target === "production" ? "--prod " : target === "preview" ? "" : `--target=${target} `;
  const inner = [
    `${cd(t.dir)}`,
    `vercel pull --yes --environment=${target} --token=$VERCEL_TOKEN`,
    `vercel build ${flag}--token=$VERCEL_TOKEN`,
    `vercel deploy --prebuilt ${flag}--token=$VERCEL_TOKEN`,
  ];
  if (t.health) inner.push(`curl -fsSL --retry 5 --retry-delay 5 --max-time 10 "${t.health}"`);
  return [`echo "▶ Deploy to Vercel"`, "npm install --global vercel@latest", `( ${inner.join(" && ")} )`].join(
    "\n",
  );
}

function migrateScript(t: Extract<Target, { type: "prisma-migrate" }>): string {
  // DATABASE_URL / DIRECT_URL come from the bound GitHub Environment's secrets.
  const inner = [cd(t.dir), "pnpm install --frozen-lockfile"];
  if (t.render_sql) {
    // Print the pending migration SQL before applying, for an auditable record
    // in the job log. Replays migrations against the shadow DB the deploy job
    // provides; tolerates an empty/failed diff so it never blocks the deploy.
    inner.push(
      `echo '── pending migration SQL ──'`,
      `(pnpm exec prisma migrate diff --from-config-datasource --to-migrations prisma/migrations --script || echo '(no diff / unavailable)')`,
    );
  }
  inner.push("pnpm run db:migrate:deploy", "pnpm run db:migrate:status");
  if (t.health) inner.push(`curl -fsSL --retry 5 --retry-delay 5 --max-time 10 "${t.health}"`);
  return [`echo "▶ Migrate database"`, `( ${inner.join(" && ")} )`].join("\n");
}

function easScript(t: Extract<Target, { type: "eas" }>): string {
  const inner = [
    cd(t.dir),
    "pnpm install --frozen-lockfile",
    `npx eas-cli build --non-interactive --no-wait --profile "${t.profile}" --platform "${t.platform}"`,
  ];
  return [`echo "▶ EAS build (${t.platform}, ${t.profile})"`, `( ${inner.join(" && ")} )`].join("\n");
}

function targetScript(t: Target): string {
  switch (t.type) {
    case "fly":
      return flyScript(t);
    case "vercel":
      return vercelScript(t);
    case "prisma-migrate":
      return migrateScript(t);
    case "eas":
      return easScript(t);
  }
}

function buildDeployPlan(config: Config, ref: string): DeployPlan {
  // Find the push branch whose ref matches (deploy is push-driven in v1).
  let matched: { branch: string; order: string[] } | null = null;
  for (const [branch, dep] of Object.entries(config.deploy)) {
    if (dep.on === "push" && ref === `refs/heads/${branch}`) {
      matched = { branch, order: dep.order };
      break;
    }
  }
  if (!matched) return { enabled: false, environment: "", script: "", pnpm: "" };

  let environment = "";
  const parts: string[] = [SH];
  for (const name of matched.order) {
    const target = config.targets[name];
    if (!target) continue;
    if (!environment && "environment" in target && target.environment) {
      environment = target.environment;
    }
    parts.push(targetScript(target));
  }
  return { enabled: true, environment, script: parts.join("\n"), pnpm: pnpmVersion(config) };
}

// ---- top-level ------------------------------------------------------------

// Decide whether a gate runs for the triggering event. Only command gates can
// be event-scoped (via `on` / `base`); typed gates (audit, drift) always run.
// With no event context (local run / unit test) every gate is included.
function gateApplies(gate: Gate, opts: PlanOptions): boolean {
  if (gate.type !== "command") return true;
  const { event, baseRef } = opts;
  if (!event) return true;
  const prOnly = !!(gate.base && gate.base.length);
  const allowed = prOnly ? ["pull_request"] : (gate.on ?? ["push", "pull_request"]);
  if (!allowed.includes(event)) return false;
  // base set → only PRs targeting one of those branches.
  if (prOnly && baseRef && !gate.base!.includes(baseRef)) return false;
  return true;
}

export function buildPlan(config: Config, ref: string, opts: PlanOptions = {}): Plan {
  const components = Object.entries(config.components).map(([id, comp]) =>
    componentEntry(id, comp, config),
  );
  const gates = Object.entries(config.gates)
    .filter(([, gate]) => gateApplies(gate, opts))
    .map(([id, gate]) => gateEntry(id, gate, config));
  const smoke = Object.entries(config.smoke)
    .filter(([id]) => !opts.suite || id === opts.suite)
    .map(([id, suite]) => smokeEntry(id, suite, config));
  const deploy = buildDeployPlan(config, ref);
  return { components, gates, smoke, deploy };
}
