import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/schema.js";
import { buildPlan } from "../src/plan.js";

function cfg() {
  const { config } = parseConfig({
    version: 1,
    defaults: { node: 24, pnpm: "10.12.4", python: "3.11" },
    components: {
      server: {
        dir: "server",
        language: "node",
        steps: ["install", "typecheck", "test"],
        env: { test: { NODE_ENV: "test" } },
      },
      ai: { dir: "ai", language: "python", docker: { targets: ["production", "test"], test: "test" } },
    },
    gates: {
      audit: { type: "pnpm-audit", level: "high", dirs: ["server"] },
      drift: { type: "prisma-drift", dir: "server" },
    },
    ci: { push: ["main", "staging"], pull_request: ["main"] },
    targets: {
      "fly-prod": { type: "fly", app: "my-app", dir: "ai", environment: "production" },
      "migrate-prod": { type: "prisma-migrate", dir: "server", environment: "production" },
      "web-prod": { type: "vercel", mode: "cli", prod: true },
    },
    deploy: {
      main: { needs_ci: ["server"], order: ["fly-prod", "migrate-prod", "web-prod"] },
    },
  });
  return config!;
}

test("components matrix has one entry per component with right setup", () => {
  const plan = buildPlan(cfg(), "refs/heads/main");
  const ids = plan.components.map((c) => c.id);
  assert.deepEqual(ids.sort(), ["ai", "server"]);
  assert.equal(plan.components.find((c) => c.id === "server")!.setup, "node");
  assert.equal(plan.components.find((c) => c.id === "ai")!.setup, "none"); // docker
});

test("node component script honors steps + test env", () => {
  const server = buildPlan(cfg(), "refs/heads/main").components.find((c) => c.id === "server")!;
  assert.match(server.script, /pnpm install --frozen-lockfile/);
  assert.match(server.script, /pnpm run typecheck/);
  assert.doesNotMatch(server.script, /pnpm run lint/); // lint not in steps
  assert.match(server.script, /export NODE_ENV="test"/);
  assert.match(server.script, /pnpm test/);
});

test("docker python component builds + runs the test image", () => {
  const ai = buildPlan(cfg(), "refs/heads/main").components.find((c) => c.id === "ai")!;
  assert.match(ai.script, /docker build --target production/);
  assert.match(ai.script, /docker run --rm ai:test/);
});

test("gates: audit + prisma-drift, drift needs db", () => {
  const plan = buildPlan(cfg(), "refs/heads/main");
  const drift = plan.gates.find((g) => g.id === "drift")!;
  assert.equal(drift.needs_db, true);
  assert.match(drift.script, /db:migrate:drift-check/);
  assert.match(plan.gates.find((g) => g.id === "audit")!.script, /pnpm audit --prod --audit-level high/);
});

test("deploy plan: matching ref → ordered chain + environment", () => {
  const d = buildPlan(cfg(), "refs/heads/main").deploy;
  assert.equal(d.enabled, true);
  assert.equal(d.environment, "production");
  // order preserved: fly before migrate before vercel
  const fly = d.script.indexOf("Deploy my-app to Fly");
  const migrate = d.script.indexOf("Migrate database");
  const vercel = d.script.indexOf("Deploy to Vercel");
  assert.ok(fly >= 0 && migrate > fly && vercel > migrate);
});

test("vercel target: production uses --prod, custom env uses --target", () => {
  const base = { needs_ci: [], on: "push" as const };
  const config = {
    version: 1 as const,
    name: "app",
    ci: { push: ["main", "staging"], pull_request: [], tags: [], cancelInProgress: true },
    defaults: { runner: "ubuntu-latest", node: 22, python: "3.11" },
    components: {},
    gates: {},
    smoke: {},
    targets: {
      "web-prod": { type: "vercel" as const, mode: "cli" as const, dir: "server", target: "production", environment: "production", prod: true },
      "web-staging": { type: "vercel" as const, mode: "cli" as const, dir: "server", target: "staging", environment: "staging", prod: true },
    },
    deploy: {
      main: { ...base, order: ["web-prod"] },
      staging: { ...base, order: ["web-staging"] },
    },
  };
  const prod = buildPlan(config as never, "refs/heads/main").deploy.script;
  assert.match(prod, /vercel build --prod /);
  assert.match(prod, /vercel deploy --prebuilt --prod /);
  assert.match(prod, /pull --yes --environment=production/);

  const staging = buildPlan(config as never, "refs/heads/staging").deploy.script;
  assert.match(staging, /vercel build --target=staging /);
  assert.match(staging, /vercel deploy --prebuilt --target=staging /);
  assert.match(staging, /pull --yes --environment=staging/);
});

test("deploy plan: non-deploy ref → disabled, empty script", () => {
  const d = buildPlan(cfg(), "refs/heads/feature-x").deploy;
  assert.equal(d.enabled, false);
  assert.equal(d.environment, "");
  assert.equal(d.script, "");
});

test("matrices serialize to valid JSON (workflow uses fromJSON)", () => {
  const plan = buildPlan(cfg(), "refs/heads/main");
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(plan.components)));
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(plan.gates)));
});

// ---- new gate capabilities ------------------------------------------------

function gatesCfg(gates: Record<string, unknown>) {
  const { config } = parseConfig({
    version: 1,
    components: { server: { dir: "server", language: "node" } },
    ci: { push: ["main", "staging"], pull_request: ["main", "staging"] },
    gates,
  });
  return config!;
}

test("command gate: full_history → fetch_depth 0; default gates stay shallow", () => {
  const config = gatesCfg({
    "append-only": {
      type: "command",
      setup: "none",
      install: false,
      on: ["pull_request"],
      full_history: true,
      run: 'sh scripts/check.sh "origin/${BASE_REF}"',
    },
  });
  const g = buildPlan(config, "refs/pull/1/merge", { event: "pull_request", baseRef: "main" }).gates;
  const ao = g.find((x) => x.id === "append-only")!;
  assert.equal(ao.fetch_depth, 0);
  assert.equal(ao.environment, "");
});

test("command gate: on/base filtering by event", () => {
  const config = gatesCfg({
    "append-only": { type: "command", on: ["pull_request"], run: "true" },
    preflight: { type: "command", base: ["staging"], environment: "staging", setup: "node", run: "true" },
  });
  // push → both PR-scoped gates excluded
  const push = buildPlan(config, "refs/heads/staging", { event: "push" }).gates.map((x) => x.id);
  assert.deepEqual(push.sort(), []);
  // PR into main → append-only yes, preflight (base staging) no
  const prMain = buildPlan(config, "refs/pull/1/merge", { event: "pull_request", baseRef: "main" }).gates.map((x) => x.id);
  assert.deepEqual(prMain.sort(), ["append-only"]);
  // PR into staging → both
  const prStaging = buildPlan(config, "refs/pull/1/merge", { event: "pull_request", baseRef: "staging" }).gates.map((x) => x.id);
  assert.deepEqual(prStaging.sort(), ["append-only", "preflight"]);
});

test("command gate: environment binds + multi-dir installs", () => {
  const config = gatesCfg({
    preflight: { type: "command", base: ["staging"], environment: "staging", setup: "node", run: "sh scripts/preflight.sh" },
    licenses: { type: "command", setup: "node", dir: "server", installs: ["server", "app"], run: "pnpm run gen:licenses:check" },
  });
  const g = buildPlan(config, "refs/pull/1/merge", { event: "pull_request", baseRef: "staging" }).gates;
  const pre = g.find((x) => x.id === "preflight")!;
  assert.equal(pre.environment, "staging");
  const lic = g.find((x) => x.id === "licenses")!;
  assert.match(lic.script, /cd "server" && pnpm install/);
  assert.match(lic.script, /cd "app" && pnpm install/);
  assert.match(lic.script, /cd "server" && pnpm run gen:licenses:check/);
});

test("no event context → every gate included (local/test runs)", () => {
  const config = gatesCfg({
    "append-only": { type: "command", on: ["pull_request"], run: "true" },
    preflight: { type: "command", base: ["staging"], run: "true" },
  });
  const ids = buildPlan(config, "refs/heads/main").gates.map((x) => x.id);
  assert.deepEqual(ids.sort(), ["append-only", "preflight"]);
});

// ---- smoke suites ---------------------------------------------------------

test("smoke suite: self-hosted runner, env exports, suite filter", () => {
  const { config } = parseConfig({
    version: 1,
    ci: { push: ["main"], pull_request: [] },
    smoke: {
      "staging-acceptance": {
        runner: ["self-hosted", "macOS"],
        setup: "node",
        environment: "staging",
        env: { MAESTRO_FLOW_DIR: ".maestro/acceptance" },
        run: "maestro test $MAESTRO_FLOW_DIR",
      },
      "api-smoke": { run: 'curl -fsSL "$STAGING_API_URL/api/health"' },
    },
  });
  const all = buildPlan(config!, "refs/heads/main").smoke;
  assert.deepEqual(all.map((s) => s.id).sort(), ["api-smoke", "staging-acceptance"]);

  const acc = all.find((s) => s.id === "staging-acceptance")!;
  assert.deepEqual(acc.runner, ["self-hosted", "macOS"]);
  assert.equal(acc.environment, "staging");
  assert.match(acc.script, /export MAESTRO_FLOW_DIR="\.maestro\/acceptance"/);
  assert.match(acc.script, /maestro test \$MAESTRO_FLOW_DIR/);

  // --suite filter keeps only the named suite
  const one = buildPlan(config!, "refs/heads/main", { suite: "api-smoke" }).smoke;
  assert.deepEqual(one.map((s) => s.id), ["api-smoke"]);
});

test("smoke matrix serializes to valid JSON", () => {
  const { config } = parseConfig({
    version: 1,
    ci: { push: ["main"], pull_request: [] },
    smoke: { e2e: { runner: "self-hosted", run: "echo ok" } },
  });
  const smoke = buildPlan(config!, "refs/heads/main").smoke;
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(smoke)));
  assert.equal(smoke[0]!.runner, "self-hosted");
});

test("prisma-migrate render_sql prints the pending diff before applying", () => {
  const { config } = parseConfig({
    version: 1,
    components: { server: { dir: "server", language: "node" } },
    ci: { push: ["staging"], pull_request: [] },
    targets: {
      "migrate-staging": { type: "prisma-migrate", dir: "server", environment: "staging", render_sql: true },
    },
    deploy: { staging: { needs_ci: ["server"], order: ["migrate-staging"] } },
  });
  const d = buildPlan(config!, "refs/heads/staging", { event: "push" }).deploy;
  const diffIdx = d.script.indexOf("prisma migrate diff");
  const deployIdx = d.script.indexOf("db:migrate:deploy");
  assert.ok(diffIdx >= 0 && deployIdx > diffIdx, "diff must render before deploy");
});
