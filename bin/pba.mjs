#!/usr/bin/env node
// Thin launcher so `pba` works from an installed package. In this repo the
// source is TypeScript run through tsx; once built (`pnpm build`) this points
// at the compiled CLI in dist/.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const built = resolve(here, "../dist/src/index.js");

if (existsSync(built)) {
  await import(built);
} else {
  // Dev path: run the TS entry through tsx.
  const { register } = await import("tsx/esm/api");
  register();
  await import(resolve(here, "../src/index.ts"));
}
