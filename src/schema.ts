import { z } from "zod";

// ---------------------------------------------------------------------------
// pba.yml schema
//
// One unified file that compiles into GitHub Actions CI + testing + deploy
// workflows. The shape is intentionally small: `components` (what to test),
// `gates` (extra blocking checks), `ci` (when to run), `targets` (deploy
// units defined once) and `deploy` (per-branch ordered deploy chains).
// ---------------------------------------------------------------------------

const branchName = z.string().min(1);
const envMap = z.record(z.string(), z.string());

// ---- defaults -------------------------------------------------------------

export const defaultsSchema = z
  .object({
    // Default GitHub-hosted (or self-hosted label array) runner for every job.
    runner: z.union([z.string(), z.array(z.string())]).default("ubuntu-latest"),
    // Node major version used by node components / setup-node.
    node: z.union([z.number(), z.string()]).default(22),
    // pnpm version passed to pnpm/action-setup. Omit to let action-setup read
    // `packageManager` from package.json instead.
    pnpm: z.union([z.number(), z.string()]).optional(),
    // Default Python version for python components.
    python: z.string().default("3.11"),
  })
  .strict()
  .default({});

// ---- components (the things that get tested) ------------------------------

// Ordered, named steps. Each maps to a concrete run step per language.
//   node:   install | prisma-generate | typecheck | lint | test | build
//   python: install | lint | typecheck | test
export const componentStep = z.enum([
  "install",
  "prisma-generate",
  "typecheck",
  "lint",
  "test",
  "build",
]);

export const dockerSchema = z
  .object({
    // Multi-stage build targets to `docker build --target <t>` in order.
    targets: z.array(z.string()).default(["production"]),
    // The image target to run as the test suite (docker run --rm img:<t>).
    test: z.string().optional(),
    // Build context directory (defaults to the component dir).
    context: z.string().optional(),
  })
  .strict();

export const componentSchema = z
  .object({
    // Working directory / workspace root for this component.
    dir: z.string().min(1),
    language: z.enum(["node", "python"]),
    // Ordered quality steps. Defaults filled in by language in normalize().
    steps: z.array(componentStep).optional(),
    // Marks the Expo/EAS workspace; referenced by the mobile workflow.
    mobile: z.boolean().default(false),
    // Per-step env injection, keyed by step name (most useful for `test`).
    env: z.record(z.string(), envMap).optional(),
    // Python-only knobs.
    python: z.string().optional(),
    docker: dockerSchema.optional(),
    // Override the global runner for just this component.
    runner: z.union([z.string(), z.array(z.string())]).optional(),
    // Postgres service container for tests that need a DB.
    services: z
      .object({
        postgres: z
          .union([
            z.boolean(),
            z.object({ image: z.string().default("postgres:16") }).strict(),
          ])
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// ---- gates (extra blocking checks beyond per-component) --------------------

export const gateSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("pnpm-audit"),
      level: z.enum(["low", "moderate", "high", "critical"]).default("high"),
      dirs: z.array(z.string()).min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("prisma-drift"),
      dir: z.string().min(1),
    })
    .strict(),
  // Escape hatch: an arbitrary blocking check. Used for the pba drift gate
  // (`pba check`) and any project-specific check the typed gates don't cover.
  z
    .object({
      type: z.literal("command"),
      name: z.string().optional(),
      dir: z.string().default("."),
      // What toolchain to set up before running. `node` also installs deps.
      setup: z.enum(["node", "python", "none"]).default("none"),
      install: z.boolean().default(true),
      // Extra workspace dirs to `pnpm install` before running (node only).
      // Use when a check spans multiple workspaces — e.g. a license manifest
      // generated from BOTH server and app dependency closures. When set, this
      // replaces the single-dir `install` behavior.
      installs: z.array(z.string()).optional(),
      run: z.string().min(1),
      // Restrict which events run this gate. Omit = both push and pull_request.
      // e.g. an append-only / merge-base check only makes sense on PRs.
      on: z.array(z.enum(["push", "pull_request"])).optional(),
      // Restrict to PRs whose base branch is one of these. Implies the gate is
      // pull_request-only (a live-DB preflight before merging into `staging`).
      base: z.array(branchName).optional(),
      // Check out full git history (fetch-depth: 0) — needed for merge-base /
      // append-only diffs against the PR base branch (exposed as $BASE_REF).
      full_history: z.boolean().default(false),
      // Bind a GitHub Environment so the gate can read that environment's
      // secrets (e.g. a live staging-DB preflight needs the staging
      // DATABASE_URL/DIRECT_URL) and respects its protection rules.
      environment: z.string().optional(),
    })
    .strict(),
]);

// ---- ci triggers ----------------------------------------------------------

export const ciSchema = z
  .object({
    push: z.array(branchName).default([]),
    pull_request: z.array(branchName).default([]),
    // Tag patterns that also trigger on push (e.g. mobile-v* releases).
    tags: z.array(z.string()).default([]),
    // Cancel superseded in-flight runs on the same ref.
    cancelInProgress: z.boolean().default(true),
  })
  .strict();

// ---- central: emit a thin caller instead of full workflows -----------------
// When present, `pba generate` emits a single caller workflow that delegates to
// a reusable workflow ("bundle") in a central repo, instead of inlining all the
// CI/deploy logic. The logic lives once in the central repo; this repo carries
// only the ~10-line caller.
export const centralSchema = z
  .object({
    // The central repo holding reusable workflows, as "owner/repo".
    repo: z.string().regex(/^[^/]+\/[^/]+$/, "must be owner/repo"),
    // Ref to pin the caller to. A mutable ref (branch / moving major tag) means
    // a change in the central repo can affect every caller at once; an
    // immutable tag or SHA freezes this repo until you bump it. Default v1.
    ref: z.string().default("v1"),
    // The reusable workflow filename in <repo>/.github/workflows (".yml" opt).
    bundle: z.string().min(1),
    // Inputs passed to the reusable workflow (its `with:`).
    with: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    // "inherit" (pass all visible secrets) or an explicit list of secret names.
    secrets: z.union([z.literal("inherit"), z.array(z.string())]).default("inherit"),
  })
  .strict();

// ---- deploy targets (defined once, referenced per branch) -----------------

const flyTarget = z
  .object({
    type: z.literal("fly"),
    app: z.string().min(1),
    dir: z.string().min(1),
    // GitHub Environment to bind (for required reviewers / secrets scoping).
    environment: z.string().optional(),
    config: z.string().default("fly.toml"),
    // Health probe path on https://<app>.fly.dev (set to false to skip).
    health: z.union([z.string(), z.literal(false)]).default("/healthz"),
  })
  .strict();

const vercelTarget = z
  .object({
    type: z.literal("vercel"),
    // cli  = CI runs `vercel deploy` (gated by the needs chain — recommended).
    // git-integration = Vercel auto-deploys on push; CI only health-probes
    //   and CANNOT block the deploy. See docs.
    mode: z.enum(["cli", "git-integration"]).default("cli"),
    environment: z.string().optional(),
    // Working dir for the vercel CLI (monorepo root or app subdir).
    dir: z.string().default("."),
    prod: z.boolean().default(true),
    // Post-deploy health probe URL (absolute).
    health: z.string().optional(),
  })
  .strict();

const prismaMigrateTarget = z
  .object({
    type: z.literal("prisma-migrate"),
    dir: z.string().min(1),
    environment: z.string().optional(),
    // Before applying, render the pending migration SQL (`migrate diff`) to the
    // job log for review. Needs a shadow DB to replay migrations against — the
    // deploy job provides one (SHADOW_DATABASE_URL).
    render_sql: z.boolean().default(false),
    // Post-migrate health probe URL (absolute).
    health: z.string().optional(),
  })
  .strict();

const easTarget = z
  .object({
    type: z.literal("eas"),
    dir: z.string().min(1),
    profile: z.string().default("production"),
    platform: z.enum(["all", "ios", "android"]).default("all"),
    environment: z.string().optional(),
  })
  .strict();

export const targetSchema = z.discriminatedUnion("type", [
  flyTarget,
  vercelTarget,
  prismaMigrateTarget,
  easTarget,
]);

// ---- per-branch deploy chains ---------------------------------------------

export const deployBranchSchema = z
  .object({
    // push = deploy on merge/push to the branch (the usual case).
    // pull_request would deploy on PRs targeting it (rare; preview envs).
    on: z.enum(["push", "pull_request"]).default("push"),
    // CI/gate job ids that must be green before the chain starts.
    needs_ci: z.array(z.string()).default([]),
    // Ordered target names. Order IS the needs chain: order[i] needs order[i-1].
    order: z.array(z.string()).min(1),
    // Optional health probe step after the whole chain finishes.
    verify: z.string().optional(),
  })
  .strict();

// ---- smoke (manual, self-hosted staging e2e suites) -----------------------
// Smoke suites run on demand (the app's thin smoke caller is workflow_dispatch)
// against a deployed environment — typically on a self-hosted runner (a macOS
// box with simulators for a Maestro device suite). Because the trigger is
// manual, committing this stays inert until a runner is online and someone
// dispatches it. Secret-backed env (TEST_PHONE, STAGING_API_URL, …) is
// forwarded by the central smoke workflow's secret passthrough; `env` here is
// for literal (non-secret) values exported before the run.
export const smokeSuiteSchema = z
  .object({
    // Runner labels. Self-hosted by default — a deployed-app device suite needs
    // a real machine (simulator/emulator), not a GitHub-hosted runner.
    runner: z.union([z.string(), z.array(z.string())]).default(["self-hosted"]),
    dir: z.string().default("."),
    // Toolchain to set up before the run. `node` also installs deps in `dir`.
    setup: z.enum(["node", "python", "none"]).default("none"),
    install: z.boolean().default(false),
    run: z.string().min(1),
    // Literal (non-secret) env exported before the run.
    env: envMap.optional(),
    // GitHub Environment to bind (reviewers / env-scoped secrets like the
    // staging DATABASE_URL). Usually the deployed env under test, e.g. staging.
    environment: z.string().optional(),
  })
  .strict();

// ---- mobile (independent EAS release workflow) ----------------------------

export const mobileSchema = z
  .object({
    dir: z.string().optional(), // defaults to the component with mobile: true
    trigger: z
      .object({
        tag: z.string().default("mobile-v*"),
        dispatch: z.boolean().default(true),
      })
      .strict()
      .default({}),
    platforms: z.array(z.enum(["all", "ios", "android"])).default(["all", "ios", "android"]),
    profiles: z.array(z.string()).default(["production", "preview"]),
    // Run component verify (typecheck + test) before spending an EAS slot.
    verify: z.boolean().default(true),
  })
  .strict();

// ---- top-level ------------------------------------------------------------

export const configSchema = z
  .object({
    version: z.literal(1),
    name: z.string().default("App"),
    defaults: defaultsSchema,
    components: z.record(z.string(), componentSchema).default({}),
    gates: z.record(z.string(), gateSchema).default({}),
    ci: ciSchema,
    targets: z.record(z.string(), targetSchema).default({}),
    deploy: z.record(branchName, deployBranchSchema).default({}),
    smoke: z.record(z.string(), smokeSuiteSchema).default({}),
    mobile: mobileSchema.optional(),
    central: centralSchema.optional(),
  })
  .strict();

export type Config = z.infer<typeof configSchema>;
export type Defaults = z.infer<typeof defaultsSchema>;
export type Component = z.infer<typeof componentSchema>;
export type Gate = z.infer<typeof gateSchema>;
export type Target = z.infer<typeof targetSchema>;
export type DeployBranch = z.infer<typeof deployBranchSchema>;
export type Mobile = z.infer<typeof mobileSchema>;
export type Central = z.infer<typeof centralSchema>;
export type SmokeSuite = z.infer<typeof smokeSuiteSchema>;
export type ComponentStep = z.infer<typeof componentStep>;

// Default step lists per language when `steps` is omitted.
export const DEFAULT_STEPS: Record<Component["language"], ComponentStep[]> = {
  node: ["install", "typecheck", "lint", "test"],
  python: ["install", "lint", "typecheck", "test"],
};

export interface ValidationIssue {
  path: string;
  message: string;
  severity: "error" | "warning";
}

export interface ParseResult {
  config?: Config;
  issues: ValidationIssue[];
}

export function hasErrors(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === "error");
}

/**
 * Validate + normalize a raw parsed YAML object into a Config, then run
 * cross-field semantic checks (references must resolve, deploy order can't
 * dangle, etc.) that zod can't express on its own.
 */
export function parseConfig(raw: unknown): ParseResult {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join(".") || "(root)",
        message: i.message,
        severity: "error" as const,
      })),
    };
  }

  const config = parsed.data;
  const issues: ValidationIssue[] = [];

  // Fill default step lists.
  for (const comp of Object.values(config.components)) {
    if (!comp.steps) comp.steps = [...DEFAULT_STEPS[comp.language]];
  }

  const componentIds = new Set(Object.keys(config.components));
  const gateIds = new Set(Object.keys(config.gates));
  const targetIds = new Set(Object.keys(config.targets));
  const ciJobIds = new Set([...componentIds, ...gateIds]);

  // Deploy chains: every needs_ci must be a real CI job; every order entry a
  // real target; vercel git-integration in an order is a no-op gate (warn).
  for (const [branch, dep] of Object.entries(config.deploy)) {
    for (const need of dep.needs_ci) {
      if (!ciJobIds.has(need)) {
        issues.push({
          path: `deploy.${branch}.needs_ci`,
          message: `"${need}" is not a known component or gate`,
          severity: "error",
        });
      }
    }
    for (const t of dep.order) {
      if (!targetIds.has(t)) {
        issues.push({
          path: `deploy.${branch}.order`,
          message: `"${t}" is not a defined target`,
          severity: "error",
        });
        continue;
      }
      const target = config.targets[t]!;
      if (target.type === "vercel" && target.mode === "git-integration") {
        issues.push({
          path: `deploy.${branch}.order`,
          message: `target "${t}" is a vercel git-integration target: it is NOT gated by CI and ignores deploy order (Vercel deploys on its own). Use mode: cli to gate it.`,
          severity: "warning",
        });
      }
    }
  }

  // Central (caller) mode: local logic is ignored — the central bundle owns it.
  if (config.central) {
    if (Object.keys(config.deploy).length || Object.keys(config.targets).length) {
      issues.push({
        path: "central",
        message:
          "central mode emits a caller; `targets`/`deploy` are ignored (the central bundle owns deploy logic). Remove them or drop `central`.",
        severity: "warning",
      });
    }
    // A mutable ref (branch, or a moving major tag like v1) means a change in
    // the central repo can break every caller at once. Flag plain branch refs.
    if (!/^v?\d+\.\d+\.\d+$/.test(config.central.ref) && !/^[0-9a-f]{40}$/.test(config.central.ref)) {
      issues.push({
        path: "central.ref",
        message: `ref "${config.central.ref}" is mutable — a change in ${config.central.repo} can affect this repo without a commit here. Pin a full version tag or SHA for zero fleet-wide blast radius.`,
        severity: "warning",
      });
    }
  }

  // Mobile: resolve the workspace dir if not given explicitly.
  if (config.mobile && !config.mobile.dir) {
    const mobileComp = Object.values(config.components).find((c) => c.mobile);
    if (!mobileComp) {
      issues.push({
        path: "mobile.dir",
        message:
          "mobile is configured but no component has `mobile: true` and no `mobile.dir` was set",
        severity: "error",
      });
    } else {
      config.mobile.dir = mobileComp.dir;
    }
  }

  return { config, issues };
}
