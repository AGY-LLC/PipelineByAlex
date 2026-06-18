import type { Component, Config, Gate } from "../schema.js";
import {
  checkoutStep,
  healthProbe,
  type Job,
  nodeStepCommand,
  orderJobKeys,
  postgresService,
  pythonStepCommand,
  resolveRunner,
  runStep,
  setupNodeSteps,
  setupPythonStep,
  type Step,
  withRetry,
  type Workflow,
} from "./helpers.js";
import { emitDeployJobs } from "./deploy.js";

// ---------------------------------------------------------------------------
// CI workflow: per-component quality jobs + gates + per-branch deploy chains.
// Everything lands in one ci.yml so deploy jobs can `needs:` the CI jobs.
// ---------------------------------------------------------------------------

function nodeComponentJob(id: string, comp: Component, config: Config): Job {
  const steps: Step[] = [checkoutStep(), ...setupNodeSteps(comp.dir, config.defaults)];
  for (const step of comp.steps ?? []) {
    const cmd = nodeStepCommand(step);
    if (!cmd) continue;
    steps.push(
      runStep(cmd.name, cmd.run, {
        dir: comp.dir,
        env: comp.env?.[step],
      }),
    );
  }
  const job: Job = {
    name: `${title(id)} (${(comp.steps ?? []).join(" + ")})`,
    "runs-on": resolveRunner(comp, config.defaults),
    steps,
  };
  attachPostgres(job, comp);
  return job;
}

function pythonComponentJob(id: string, comp: Component, config: Config): Job {
  // Docker-based python component: build the declared stages, run the test
  // image. Mirrors the nisatsu ai-service job.
  if (comp.docker) {
    const ctx = comp.docker.context ?? comp.dir;
    const steps: Step[] = [checkoutStep()];
    for (const target of comp.docker.targets) {
      steps.push(
        runStep(
          `Build ${target} image`,
          withRetry(
            `docker build --target ${target} -t ${imageTag(comp.dir, target)} ${ctx}`,
          ),
        ),
      );
    }
    const testTarget = comp.docker.test ?? (comp.docker.targets.includes("test") ? "test" : undefined);
    if (testTarget) {
      steps.push(
        runStep("Run tests in image", `docker run --rm ${imageTag(comp.dir, testTarget)}`),
      );
    }
    return {
      name: `${title(id)} (docker build + tests)`,
      "runs-on": resolveRunner(comp, config.defaults),
      steps,
    };
  }

  // Plain python component: pip install + ruff/mypy/pytest.
  const version = comp.python ?? config.defaults.python;
  const steps: Step[] = [checkoutStep(), setupPythonStep(version)];
  for (const step of comp.steps ?? []) {
    const cmd = pythonStepCommand(step);
    if (!cmd) continue;
    steps.push(runStep(cmd.name, cmd.run, { dir: comp.dir, env: comp.env?.[step] }));
  }
  const job: Job = {
    name: `${title(id)} (${(comp.steps ?? []).join(" + ")})`,
    "runs-on": resolveRunner(comp, config.defaults),
    steps,
  };
  attachPostgres(job, comp);
  return job;
}

function attachPostgres(job: Job, comp: Component): void {
  const pg = comp.services?.postgres;
  if (!pg) return;
  const image = typeof pg === "object" ? pg.image : "postgres:16";
  job.services = { postgres: postgresService(image, "test") };
}

function gateJob(id: string, gate: Gate, config: Config): Job {
  if (gate.type === "pnpm-audit") {
    const steps: Step[] = [checkoutStep(), ...setupNodeSteps(gate.dirs[0]!, config.defaults)];
    for (const dir of gate.dirs) {
      steps.push(
        runStep(
          `Audit ${dir} (prod deps, ${gate.level}+)`,
          withRetry(`pnpm audit --prod --audit-level ${gate.level}`),
          { dir },
        ),
      );
    }
    return {
      name: `Dependency audit (${gate.level}+)`,
      "runs-on": config.defaults.runner,
      steps,
    };
  }

  if (gate.type === "command") {
    const steps: Step[] = [checkoutStep(gate.full_history ? { fetchDepth: 0 } : undefined)];
    if (gate.setup === "node") {
      steps.push(...setupNodeSteps(gate.dir, config.defaults));
      // Explicit `installs` list (multi-workspace) wins over single gate.dir.
      const dirs = gate.installs ?? (gate.install ? [gate.dir] : []);
      for (const dir of dirs) {
        steps.push(runStep(`Install deps (${dir})`, "pnpm install --frozen-lockfile", { dir }));
      }
    } else if (gate.setup === "python") {
      steps.push(setupPythonStep(config.defaults.python));
      if (gate.install) {
        steps.push(
          runStep("Install deps", "python -m pip install --upgrade pip\npip install -e '.[dev]'", {
            dir: gate.dir,
          }),
        );
      }
    }
    steps.push(runStep(gate.name ?? id, gate.run, { dir: gate.dir === "." ? undefined : gate.dir }));
    const job: Job = {
      name: gate.name ?? id,
      "runs-on": config.defaults.runner,
      steps,
    };
    const cond = commandGateCondition(gate);
    if (cond) job.if = cond;
    if (gate.environment) job.environment = gate.environment;
    // An env-bound gate reads the bound environment's DB secrets; a full-history
    // gate needs the PR base branch. Surface both as env when relevant.
    const env: Record<string, string> = {};
    if (gate.environment) {
      env.DATABASE_URL = "${{ secrets.DATABASE_URL }}";
      env.DIRECT_URL = "${{ secrets.DIRECT_URL }}";
    }
    if (gate.full_history || (gate.base && gate.base.length)) {
      env.BASE_REF = "${{ github.base_ref }}";
    }
    if (Object.keys(env).length) job.env = env;
    return job;
  }

  // prisma-drift: shadow postgres + drift-check script.
  return {
    name: "Prisma (schema drift check)",
    "runs-on": config.defaults.runner,
    services: { shadow: postgresService("postgres:16", "shadow") },
    steps: [
      checkoutStep(),
      ...setupNodeSteps(gate.dir, config.defaults),
      runStep("Install deps", "pnpm install --frozen-lockfile", { dir: gate.dir }),
      runStep("Check schema ↔ migrations drift", "pnpm run db:migrate:drift-check", {
        dir: gate.dir,
        env: { SHADOW_DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/shadow" },
      }),
    ],
  };
}

export function buildCiWorkflow(config: Config): Workflow {
  const jobs: Record<string, Job> = {};

  for (const [id, comp] of Object.entries(config.components)) {
    jobs[id] =
      comp.language === "node"
        ? nodeComponentJob(id, comp, config)
        : pythonComponentJob(id, comp, config);
  }
  for (const [id, gate] of Object.entries(config.gates)) {
    jobs[id] = gateJob(id, gate, config);
  }

  // Deploy chains (gated by CI jobs above) live in the same workflow.
  Object.assign(jobs, emitDeployJobs(config));

  // Normalize key order across every job for readable, diff-stable output.
  for (const id of Object.keys(jobs)) jobs[id] = orderJobKeys(jobs[id]!);

  const on: Record<string, unknown> = {};
  if (config.ci.push.length || config.ci.tags.length) {
    const push: Record<string, unknown> = {};
    if (config.ci.push.length) push.branches = config.ci.push;
    if (config.ci.tags.length) push.tags = config.ci.tags;
    on.push = push;
  }
  if (config.ci.pull_request.length) on.pull_request = { branches: config.ci.pull_request };

  const workflow: Workflow = {
    name: "CI",
    on,
    permissions: { contents: "read" },
    jobs,
  };
  if (config.ci.cancelInProgress) {
    workflow.concurrency = { group: "ci-${{ github.ref }}", "cancel-in-progress": true };
  }
  return workflow;
}

// A command gate may be scoped to PRs (optionally by base branch) or to a
// single event via `on`. Mirrors the runtime interpreter's gateApplies filter.
function commandGateCondition(
  gate: Extract<Gate, { type: "command" }>,
): string | undefined {
  if (gate.base && gate.base.length) {
    const bases = gate.base.map((b) => `github.base_ref == '${b}'`).join(" || ");
    return `github.event_name == 'pull_request' && (${bases})`;
  }
  const on = gate.on ?? ["push", "pull_request"];
  if (on.length === 1) return `github.event_name == '${on[0]}'`;
  return undefined;
}

function imageTag(dir: string, target: string): string {
  return `${dir.replace(/[^a-z0-9]+/gi, "-")}:${target}`;
}

function title(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Re-export for the health-probe verify step builder used by deploy.ts.
export { healthProbe };
