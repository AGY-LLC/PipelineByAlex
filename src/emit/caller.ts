import type { Config } from "../schema.js";
import type { CallerJob, Workflow } from "./helpers.js";

// ---------------------------------------------------------------------------
// Central (caller) mode. Emits the thin per-repo workflow that owns the trigger
// and delegates all logic to a reusable workflow ("bundle") in a central repo.
// This is the ~10-line file that lives in each app repo.
// ---------------------------------------------------------------------------

export function buildCallerWorkflow(config: Config): Workflow {
  const c = config.central!;

  // Trigger is always local (reusable workflows can't be triggered directly).
  const on: Record<string, unknown> = {};
  const push: Record<string, unknown> = {};
  if (config.ci.push.length) push.branches = config.ci.push;
  if (config.ci.tags.length) push.tags = config.ci.tags;
  if (Object.keys(push).length) on.push = push;
  if (config.ci.pull_request.length) on.pull_request = { branches: config.ci.pull_request };

  const bundle = c.bundle.endsWith(".yml") ? c.bundle : `${c.bundle}.yml`;
  const job: CallerJob = {
    uses: `${c.repo}/.github/workflows/${bundle}@${c.ref}`,
  };
  if (c.with && Object.keys(c.with).length) job.with = c.with;
  job.secrets =
    c.secrets === "inherit"
      ? "inherit"
      : Object.fromEntries(c.secrets.map((name) => [name, `\${{ secrets.${name} }}`]));

  return {
    name: "CI",
    on,
    jobs: { pipeline: job },
  };
}
