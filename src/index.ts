import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { hasErrors, type ValidationIssue } from "./schema.js";
import { generateFiles, loadConfig } from "./generate.js";

// ---------------------------------------------------------------------------
// pba CLI
//   pba generate [--config pba.yml] [--out .]   write workflow files
//   pba check    [--config pba.yml] [--out .]   fail if files are stale
// ---------------------------------------------------------------------------

interface Args {
  config: string;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { config: "pba.yml", out: "." };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === "--config" || a === "-c") && argv[i + 1]) args.config = argv[++i]!;
    else if ((a === "--out" || a === "-o") && argv[i + 1]) args.out = argv[++i]!;
  }
  return args;
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
    default:
      process.stdout.write(
        [
          "pba — compile pba.yml into GitHub Actions workflows",
          "",
          "Usage:",
          "  pba generate [--config pba.yml] [--out .]   write workflow files",
          "  pba check    [--config pba.yml] [--out .]   fail if files are stale (CI drift gate)",
          "",
        ].join("\n"),
      );
      if (cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h") process.exit(1);
  }
}

main();
