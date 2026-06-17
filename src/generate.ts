import { readFileSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { type Config, parseConfig, type ValidationIssue } from "./schema.js";
import { buildCiWorkflow } from "./emit/ci.js";
import { buildMobileWorkflow } from "./emit/mobile.js";
import { buildCallerWorkflow } from "./emit/caller.js";
import type { Workflow } from "./emit/helpers.js";

const HEADER = `# ─────────────────────────────────────────────────────────────────────────
# GENERATED FROM pba.yml — DO NOT EDIT BY HAND.
# Edit pba.yml and run \`pba generate\`. CI runs \`pba check\` to fail on drift.
# ─────────────────────────────────────────────────────────────────────────
`;

export interface LoadResult {
  config?: Config;
  issues: ValidationIssue[];
}

export function loadConfig(path: string): LoadResult {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {
      issues: [{ path, message: `cannot read config file: ${path}`, severity: "error" }],
    };
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    return {
      issues: [{ path, message: `invalid YAML: ${(err as Error).message}`, severity: "error" }],
    };
  }
  return parseConfig(raw);
}

export function serializeWorkflow(workflow: Workflow): string {
  const body = stringifyYaml(workflow, {
    lineWidth: 0, // never wrap — keep run blocks intact
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN",
    aliasDuplicateObjects: false, // no &anchors/*aliases — keep workflows literal
  });
  return `${HEADER}\n${body}`;
}

/** Map of repo-relative output path -> file contents. Deterministic. */
export function generateFiles(config: Config): Map<string, string> {
  const out = new Map<string, string>();

  // Central mode: emit only the thin caller; the central bundle owns the logic.
  if (config.central) {
    out.set(".github/workflows/ci.yml", serializeWorkflow(buildCallerWorkflow(config)));
    return out;
  }

  out.set(".github/workflows/ci.yml", serializeWorkflow(buildCiWorkflow(config)));

  const mobile = buildMobileWorkflow(config);
  if (mobile) {
    out.set(".github/workflows/eas-build.yml", serializeWorkflow(mobile));
  }
  return out;
}
