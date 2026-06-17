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
