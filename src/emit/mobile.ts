import type { Config } from "../schema.js";
import {
  checkoutStep,
  EXPO_ACTION,
  type Job,
  orderJobKeys,
  runStep,
  setupNodeSteps,
  type Step,
  type Workflow,
} from "./helpers.js";

// ---------------------------------------------------------------------------
// Independent mobile release workflow (eas-build.yml). Triggered by a tag
// (mobile-v*) and/or manual dispatch with profile + platform inputs — so a
// paid EAS slot is only spent on a deliberate release, not every push.
// ---------------------------------------------------------------------------

export function buildMobileWorkflow(config: Config): Workflow | null {
  const m = config.mobile;
  if (!m || !m.dir) return null;
  const dir = m.dir;

  const on: Record<string, unknown> = {};
  if (m.trigger.tag) on.push = { tags: [m.trigger.tag] };
  if (m.trigger.dispatch) {
    on.workflow_dispatch = {
      inputs: {
        profile: {
          description: "EAS build profile",
          required: true,
          default: m.profiles[0] ?? "production",
          type: "choice",
          options: m.profiles,
        },
        platform: {
          description: "Platform",
          required: true,
          default: m.platforms[0] ?? "all",
          type: "choice",
          options: m.platforms,
        },
      },
    };
  }

  const jobs: Record<string, Job> = {};

  if (m.verify) {
    jobs.verify = {
      name: "Verify before build",
      "runs-on": config.defaults.runner,
      steps: [
        checkoutStep(),
        ...setupNodeSteps(dir, config.defaults),
        runStep("Install deps", "pnpm install --frozen-lockfile", { dir }),
        runStep("Typecheck", "pnpm run typecheck", { dir }),
        runStep("Test", "pnpm test", { dir }),
      ],
    };
  }

  const buildSteps: Step[] = [
    checkoutStep(),
    ...setupNodeSteps(dir, config.defaults),
    {
      name: "Setup EAS",
      uses: EXPO_ACTION,
      with: { "eas-version": "^13", token: "${{ secrets.EXPO_TOKEN }}", packager: "pnpm" },
    },
    runStep("Install deps", "pnpm install --frozen-lockfile", { dir }),
    runStep(
      "Run EAS build",
      [
        "eas build \\",
        "  --non-interactive \\",
        "  --no-wait \\",
        '  --profile "$PROFILE" \\',
        '  --platform "$PLATFORM"',
      ].join("\n"),
      {
        dir,
        // Defaults make a tag push build production/all; dispatch overrides.
        env: {
          PROFILE: `\${{ github.event.inputs.profile || '${m.profiles[0] ?? "production"}' }}`,
          PLATFORM: `\${{ github.event.inputs.platform || '${m.platforms[0] ?? "all"}' }}`,
        },
      },
    ),
  ];

  const build: Job = {
    name: "EAS build",
    "runs-on": config.defaults.runner,
    steps: buildSteps,
  };
  if (m.verify) build.needs = ["verify"];
  jobs.build = build;

  for (const id of Object.keys(jobs)) jobs[id] = orderJobKeys(jobs[id]!);

  return {
    name: "EAS Build (mobile)",
    on,
    permissions: { contents: "read" },
    concurrency: {
      group: "eas-${{ github.event.inputs.profile || github.ref }}",
      "cancel-in-progress": false,
    },
    jobs,
  };
}
