import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { hasErrors, type ValidationIssue } from "./schema.js";
import { generateFiles, loadConfig } from "./generate.js";
import { buildPlan } from "./plan.js";

// ---------------------------------------------------------------------------
// pba CLI
//   pba generate [--config pba.yml] [--out .]   write workflow files
//   pba check    [--config pba.yml] [--out .]   fail if files are stale
// ---------------------------------------------------------------------------

interface Args {
  config: string;
  out: string;
  ref: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    config: "pba.yml",
    out: ".",
    ref: process.env.GITHUB_REF ?? "",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === "--config" || a === "-c") && argv[i + 1]) args.config = argv[++i]!;
    else if ((a === "--out" || a === "-o") && argv[i + 1]) args.out = argv[++i]!;
    else if ((a === "--ref" || a === "-r") && argv[i + 1]) args.ref = argv[++i]!;
  }
  return args;
}

/** Emit key/value pairs to $GITHUB_OUTPUT (heredoc for multiline) or stdout. */
function writeOutputs(outputs: Record<string, string>): void {
  let buf = "";
  for (const [k, v] of Object.entries(outputs)) {
    if (v.includes("\n")) {
      const delim = `__PBA_${k.toUpperCase()}_EOF__`;
      buf += `${k}<<${delim}\n${v}\n${delim}\n`;
    } else {
      buf += `${k}=${v}\n`;
    }
  }
  const gh = process.env.GITHUB_OUTPUT;
  if (gh) appendFileSync(gh, buf);
  else process.stdout.write(buf);
}

function printIssues(issues: ValidationIssue[]): void {
  for (const i of issues) {
    const tag = i.severity === "error" ? "✗ error" : "⚠ warning";
    process.stderr.write(`  ${tag}  ${i.path}: ${i.message}\n`);
  }
}

function load(configPath: string) {
  const { config, issues } = loadConfig(configPath);
  if (issues.length) {
    process.stderr.write(`pba: ${configPath}\n`);
    printIssues(issues);
  }
  if (!config || hasErrors(issues)) {
    process.stderr.write("\npba: configuration has errors; aborting.\n");
    process.exit(1);
  }
  return config;
}

function cmdGenerate(args: Args): void {
  const config = load(args.config);
  const files = generateFiles(config);
  for (const [rel, content] of files) {
    const abs = resolve(args.out, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
    process.stdout.write(`  wrote ${rel}\n`);
  }
  process.stdout.write(`pba: generated ${files.size} workflow file(s).\n`);
}

function cmdCheck(args: Args): void {
  const config = load(args.config);
  const files = generateFiles(config);
  const stale: string[] = [];
  for (const [rel, content] of files) {
    const abs = resolve(args.out, rel);
    const current = existsSync(abs) ? readFileSync(abs, "utf8") : null;
    if (current !== content) stale.push(rel);
  }
  if (stale.length) {
    process.stderr.write("pba: generated workflows are out of date:\n");
    for (const s of stale) process.stderr.write(`  ✗ ${s}\n`);
    process.stderr.write("\nRun `pba generate` and commit the result.\n");
    process.exit(1);
  }
  process.stdout.write(`pba: ${files.size} workflow file(s) up to date.\n`);
}

function cmdPlan(args: Args): void {
  const config = load(args.config);
  const plan = buildPlan(config, args.ref);
  writeOutputs({
    components: JSON.stringify(plan.components),
    gates: JSON.stringify(plan.gates),
    deploy_enabled: String(plan.deploy.enabled),
    deploy_environment: plan.deploy.environment,
    deploy_script: plan.deploy.script,
  });
}

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (cmd) {
    case "generate":
    case "gen":
      cmdGenerate(args);
      break;
    case "check":
      cmdCheck(args);
      break;
    case "plan":
      cmdPlan(args);
      break;
    default:
      process.stdout.write(
        [
          "pba — compile pba.yml into GitHub Actions workflows",
          "",
          "Usage:",
          "  pba plan     [--config pba.yml] [--ref <git-ref>]   emit CI matrices + deploy script (runtime interpreter)",
          "  pba generate [--config pba.yml] [--out .]           write workflow files (standalone mode)",
          "  pba check    [--config pba.yml] [--out .]           fail if files are stale (drift gate)",
          "",
        ].join("\n"),
      );
      if (cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h") process.exit(1);
  }
}

main();
