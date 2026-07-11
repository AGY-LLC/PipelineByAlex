import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { hasErrors, parseConfig } from "../src/schema.js";
import { generateFiles } from "../src/generate.js";
import { buildCiWorkflow } from "../src/emit/ci.js";
import { buildCallerWorkflow } from "../src/emit/caller.js";
import type { CallerJob, Job } from "../src/emit/helpers.js";

function cfg(extra: Record<string, unknown> = {}) {
  return parseConfig({
    version: 1,
    name: "t",
    components: {
      server: { dir: "server", language: "node", steps: ["install", "typecheck", "test"] },
    },
    ci: { push: ["main", "staging"], pull_request: ["main"] },
    targets: {
      "fly-prod": { type: "fly", app: "my-app", dir: "ai", environment: "production" },
      "migrate-prod": { type: "prisma-migrate", dir: "server", environment: "production" },
      "web-prod": { type: "vercel", mode: "cli", prod: true },
    },
    deploy: {
      main: { on: "push", needs_ci: ["server"], order: ["fly-prod", "migrate-prod", "web-prod"] },
    },
    ...extra,
  });
}

test("valid config parses with no errors", () => {
  const { config, issues } = cfg();
  assert.ok(config);
  assert.equal(hasErrors(issues), false);
});

test("deploy order becomes a needs chain", () => {
  const { config } = cfg();
  const wf = buildCiWorkflow(config!);
  assert.deepEqual(wf.jobs["fly-prod"]!.needs, ["server"]); // first gates on CI
  assert.deepEqual(wf.jobs["migrate-prod"]!.needs, ["fly-prod"]);
  assert.deepEqual(wf.jobs["web-prod"]!.needs, ["migrate-prod"]);
});

test("every deploy job is branch-gated by an if condition", () => {
  const { config } = cfg();
  const wf = buildCiWorkflow(config!);
  for (const id of ["fly-prod", "migrate-prod", "web-prod"]) {
    assert.match(wf.jobs[id]!.if!, /refs\/heads\/main/);
  }
});

test("vercel cli deploy is gated (a real job in the chain)", () => {
  const { config } = cfg();
  const wf = buildCiWorkflow(config!);
  const web = wf.jobs["web-prod"] as Job;
  assert.ok(web.steps.some((s) => String(s.run ?? "").includes("vercel deploy")));
  assert.ok(web.needs && web.needs.length > 0); // cannot run unless chain green
});

test("unknown target in deploy order is an error", () => {
  const { issues } = cfg({
    deploy: { main: { on: "push", needs_ci: ["server"], order: ["nope"] } },
  });
  assert.ok(hasErrors(issues));
});

test("unknown needs_ci reference is an error", () => {
  const { issues } = cfg({
    deploy: { main: { on: "push", needs_ci: ["ghost"], order: ["fly-prod"] } },
  });
  assert.ok(hasErrors(issues));
});

test("vercel git-integration in order warns but does not error", () => {
  const { issues } = cfg({
    targets: {
      "fly-prod": { type: "fly", app: "a", dir: "ai" },
      web: { type: "vercel", mode: "git-integration" },
    },
    deploy: { main: { on: "push", needs_ci: ["server"], order: ["web"] } },
  });
  assert.equal(hasErrors(issues), false);
  assert.ok(issues.some((i) => i.severity === "warning"));
});

test("generated workflows are valid YAML", () => {
  const { config } = cfg();
  for (const [, content] of generateFiles(config!)) {
    assert.doesNotThrow(() => parseYaml(content));
  }
});

test("python docker component emits build + test image steps", () => {
  const { config } = parseConfig({
    version: 1,
    components: {
      ai: { dir: "ai", language: "python", docker: { targets: ["production", "test"], test: "test" } },
    },
    ci: { push: ["main"], pull_request: [] },
  });
  const wf = buildCiWorkflow(config!);
  const names = (wf.jobs.ai as Job).steps.map((s) => s.name);
  assert.ok(names.includes("Build production image"));
  assert.ok(names.includes("Run tests in image"));
});

test("central mode emits a thin caller, not full workflows", () => {
  const { config, issues } = parseConfig({
    version: 1,
    ci: { push: ["main"], pull_request: ["main"] },
    central: {
      repo: "agy/agy-ci",
      ref: "v1",
      bundle: "backend-service",
      with: { "fly-app": "my-api-prod" },
      secrets: "inherit",
    },
  });
  assert.ok(config);
  assert.equal(hasErrors(issues), false);

  const files = generateFiles(config!);
  assert.deepEqual([...files.keys()], [".github/workflows/ci.yml"]); // caller only

  const wf = buildCallerWorkflow(config!);
  const job = wf.jobs.ci as CallerJob;
  assert.equal(job.uses, "agy/agy-ci/.github/workflows/backend-service.yml@v1");
  assert.deepEqual(job.with, { "fly-app": "my-api-prod" });
  assert.equal(job.secrets, "inherit");
});

test("central explicit secrets become a secrets map", () => {
  const { config } = parseConfig({
    version: 1,
    ci: { push: ["main"], pull_request: [] },
    central: { repo: "agy/agy-ci", ref: "v1", bundle: "web-app", secrets: ["VERCEL_TOKEN"] },
  });
  const job = buildCallerWorkflow(config!).jobs.ci as CallerJob;
  assert.deepEqual(job.secrets, { VERCEL_TOKEN: "${{ secrets.VERCEL_TOKEN }}" });
});

test("central runtime keeps targets and deploy as interpreter input", () => {
  const { config, issues } = parseConfig({
    version: 1,
    ci: { push: ["main"], pull_request: [] },
    targets: { web: { type: "vercel", mode: "cli", target: "production" } },
    deploy: { main: { order: ["web"] } },
    central: {
      repo: "agy/agy-ci",
      ref: "0123456789abcdef0123456789abcdef01234567",
      bundle: "pipeline",
      secrets: [],
    },
  });
  assert.ok(config);
  assert.equal(hasErrors(issues), false);
  assert.equal(issues.some((issue) => issue.path === "central"), false);
});

test("central caller can pass no secrets and only cancels superseded PRs", () => {
  const { config } = parseConfig({
    version: 1,
    ci: { push: ["main"], pull_request: ["main"], cancelInProgress: true },
    central: { repo: "agy/agy-ci", ref: "0123456789abcdef0123456789abcdef01234567", bundle: "pipeline", secrets: [] },
  });
  const workflow = buildCallerWorkflow(config!);
  const job = workflow.jobs.ci as CallerJob;
  assert.equal(job.secrets, undefined);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.concurrency?.["cancel-in-progress"], "${{ github.event_name == 'pull_request' }}");
});

test("mutable central ref warns", () => {
  const { issues } = parseConfig({
    version: 1,
    ci: { push: ["main"], pull_request: [] },
    central: { repo: "agy/agy-ci", ref: "main", bundle: "web-app" },
  });
  assert.ok(issues.some((i) => i.severity === "warning" && i.path === "central.ref"));
});

test("central pipeline exposes a stable verify check and deploys only after it succeeds", () => {
  const source = readFileSync(".github/workflows/pipeline.yml", "utf8");
  const workflow = parseYaml(source) as Record<string, any>;
  const verify = workflow.jobs.verify;
  const deploy = workflow.jobs.deploy;

  assert.deepEqual(verify.needs, ["plan", "test", "gates"]);
  assert.equal(verify.if, "${{ always() }}");
  const enforcement = String(verify.steps.at(-1)?.run ?? "");
  assert.match(enforcement, /success\|skipped/);
  assert.doesNotMatch(enforcement, /!= ['\"]failure/);

  assert.deepEqual(deploy.needs, ["plan", "verify"]);
  assert.match(deploy.if, /needs\.plan\.result == 'success'/);
  assert.match(deploy.if, /needs\.verify\.result == 'success'/);
});

test("central pipeline actions use immutable full commit SHAs", () => {
  const source = readFileSync(".github/workflows/pipeline.yml", "utf8");
  const refs = [...source.matchAll(/^\s*uses:\s*([^\s#]+)\s*(?:#.*)?$/gm)].map((match) => match[1]!);
  assert.ok(refs.length > 0);
  for (const ref of refs) {
    assert.match(ref, /@[0-9a-f]{40}$/, `${ref} is not immutable`);
  }
});
