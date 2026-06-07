#!/usr/bin/env bun
// Push the contents of release-notes/v<VERSION>.md to the GitHub Release body
// for tag v<VERSION>. Invoked from apply-release-notes.yml after a
// release-notes PR is merged to main.
//
// Usage:
//   bun apps/cli/scripts/apply-release-notes.ts --tag v2.101.0
import { $ } from "bun";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    tag: { type: "string" },
  },
  strict: true,
});

const tag = values.tag;
if (!tag) {
  console.error("--tag is required (e.g. --tag v2.101.0)");
  process.exit(2);
}
const version = tag.replace(/^v/, "");

const repoRoot = (await $`git rev-parse --show-toplevel`.text()).trim();
const notesPath = path.join(repoRoot, "release-notes", `v${version}.md`);
if (!existsSync(notesPath)) {
  console.error(`No notes file at ${path.relative(repoRoot, notesPath)}`);
  process.exit(1);
}

console.error(`==> Updating GitHub Release body for ${tag}`);
await $`gh release edit ${tag} --notes-file ${notesPath}`.cwd(repoRoot);
console.error(`==> Done`);
