#!/usr/bin/env bun
// Generate a user-centric GitHub Release body for a stable Supabase CLI tag
// by running the Claude Agent SDK against tools/release/release-notes-prompt.md
// with the raw semantic-release block substituted in.
//
// Pipeline shape:
//   1. `backfill-release-notes.ts --tag <tag>` produces the raw semantic-release
//      markdown (without writing anything to the GH release). We always
//      re-derive this so the proposer is decoupled from whatever happens to
//      sit in the release body at the moment.
//   2. The raw block is inlined into tools/release/release-notes-prompt.md in
//      place of the {{PASTE_SEMANTIC_RELEASE_BLOCK_HERE}} placeholder.
//   3. The Claude Agent SDK runs the rendered prompt with WebFetch + Bash so
//      it can investigate PR bodies, linked issues, and changed files (the
//      prompt's investigation step is real work, not boilerplate).
//   4. The agent's final assistant message is written to
//      release-notes/v<VERSION>.md.
//   5. Unless --dry-run is passed, the script commits the file on a branch
//      `release-notes/v<VERSION>` and opens a PR. Merging the PR triggers
//      apply-release-notes.yml which pushes the file's contents to the GH
//      release body.
//
// Usage:
//   bun apps/cli/scripts/propose-release-notes.ts --tag v2.101.0 --dry-run
//   bun apps/cli/scripts/propose-release-notes.ts --tag v2.101.0 --apply
//
//   --tag      Required. Stable release tag (e.g. v2.101.0). Prerelease tags
//              (-beta./-alpha.) are rejected per the prompt's scope rules.
//   --dry-run  Print the proposed notes to stdout. Does not write any files,
//              does not touch git.
//   --apply    Write release-notes/v<VERSION>.md, commit on a branch, push,
//              and open a PR. Default behavior when neither flag is passed
//              is `--dry-run`.
//   --render-only  Print the rendered prompt (template + raw notes block)
//              and exit before any LLM call. Useful for prompt iteration
//              and for verifying the pipeline shape without spending tokens.
//   --model    Optional. Override the Claude model (default: claude-opus-4-7).
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { $ } from "bun";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    tag: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    apply: { type: "boolean", default: false },
    "render-only": { type: "boolean", default: false },
    model: { type: "string", default: "claude-opus-4-7" },
  },
  strict: true,
});

const tag = values.tag;
if (!tag) {
  console.error("--tag is required (e.g. --tag v2.101.0)");
  process.exit(2);
}
if (tag.includes("-beta.") || tag.includes("-alpha.")) {
  console.error(
    `Refusing to propose notes for ${tag}: prereleases keep the raw ` +
      `semantic-release body (see tools/release/release-notes-prompt.md).`,
  );
  process.exit(0);
}
const version = tag.replace(/^v/, "");
const apply = values.apply === true && values["dry-run"] !== true;

const repoRoot = (await $`git rev-parse --show-toplevel`.text()).trim();
const promptPath = path.join(repoRoot, "tools/release/release-notes-prompt.md");
const backfillScript = path.join(repoRoot, "apps/cli/scripts/backfill-release-notes.ts");
const notesDir = path.join(repoRoot, "release-notes");
const notesPath = path.join(notesDir, `v${version}.md`);

console.error(`==> Re-deriving raw semantic-release notes for ${tag}`);
const rawNotes = (await $`bun ${backfillScript} --tag ${tag}`.cwd(repoRoot).text()).trim();
if (!rawNotes) {
  console.error(`backfill-release-notes produced no output for ${tag}`);
  process.exit(1);
}

const promptTemplate = await readFile(promptPath, "utf8");
const placeholder = "{{PASTE_SEMANTIC_RELEASE_BLOCK_HERE}}";
if (!promptTemplate.includes(placeholder)) {
  console.error(`Prompt template at ${promptPath} is missing ${placeholder}`);
  process.exit(1);
}
const rendered = promptTemplate.replace(placeholder, rawNotes);

if (values["render-only"]) {
  process.stdout.write(rendered);
  process.exit(0);
}

console.error(`==> Running Claude Agent SDK (model=${values.model})`);
const options: Options = {
  model: values.model,
  // The agent needs WebFetch / WebSearch to investigate PR bodies and linked
  // issues per the prompt's step 3, and Bash so it can use `gh` for
  // authenticated GitHub queries instead of HTML scraping. Edit/Write are
  // intentionally excluded — the script owns the final file output.
  allowedTools: ["WebFetch", "WebSearch", "Bash"],
  permissionMode: "bypassPermissions",
  // Don't load the repo's CLAUDE.md or settings.json — the prompt is
  // self-contained and we don't want unrelated agent context bleeding in.
  settingSources: [],
  cwd: repoRoot,
};

let finalText = "";
let cost = 0;
const stream = query({ prompt: rendered, options });
for await (const msg of stream) {
  if (msg.type === "result") {
    if (msg.subtype === "success") {
      finalText = msg.result;
      cost = msg.total_cost_usd;
    } else {
      console.error(`Agent failed: ${msg.subtype}`);
      if (msg.errors?.length) console.error(msg.errors.join("\n"));
      process.exit(1);
    }
  }
}

if (!finalText.trim()) {
  console.error("Agent returned no result text");
  process.exit(1);
}

const normalized = finalText.endsWith("\n") ? finalText : `${finalText}\n`;
console.error(`==> Agent finished (cost ~$${cost.toFixed(4)})`);

if (!apply) {
  process.stdout.write(normalized);
  process.exit(0);
}

await mkdir(notesDir, { recursive: true });
if (existsSync(notesPath)) {
  console.error(
    `Refusing to overwrite existing ${path.relative(repoRoot, notesPath)}. ` +
      `Delete it or rerun with --dry-run to preview.`,
  );
  process.exit(1);
}
await writeFile(notesPath, normalized);
console.error(`==> Wrote ${path.relative(repoRoot, notesPath)}`);

const branch = `release-notes/v${version}`;
const currentBranch = (await $`git rev-parse --abbrev-ref HEAD`.cwd(repoRoot).text()).trim();
if (currentBranch !== branch) {
  await $`git checkout -B ${branch}`.cwd(repoRoot);
}
await $`git add ${notesPath}`.cwd(repoRoot);
const commitMessage = `docs(release): propose user-facing notes for ${tag}`;
await $`git commit -m ${commitMessage}`.cwd(repoRoot);

console.error(`==> Pushing ${branch}`);
let pushed = false;
for (let attempt = 0; attempt < 4; attempt++) {
  const result = await $`git push -u origin ${branch}`.cwd(repoRoot).nothrow();
  if (result.exitCode === 0) {
    pushed = true;
    break;
  }
  const wait = 2 ** (attempt + 1) * 1000;
  console.error(`Push failed (attempt ${attempt + 1}/4); retrying in ${wait / 1000}s`);
  await new Promise((r) => setTimeout(r, wait));
}
if (!pushed) {
  console.error("git push failed after 4 attempts");
  process.exit(1);
}

const prBody = [
  `Proposed user-facing release notes for ${tag}, generated by`,
  "`apps/cli/scripts/propose-release-notes.ts` against",
  "`tools/release/release-notes-prompt.md`.",
  "",
  "**Merging this PR will overwrite the GitHub Release body for**",
  `**[${tag}](https://github.com/supabase/cli/releases/tag/${tag})**`,
  "via `.github/workflows/apply-release-notes.yml`.",
  "",
  "Reviewers: edit the file directly to refine wording or fix omissions.",
  "Close without merging if the auto-generated body should stand instead.",
].join(" ");

await $`gh pr create --title ${`docs(release): notes for ${tag}`} --body ${prBody} --base main --head ${branch}`.cwd(
  repoRoot,
);
console.error(`==> PR opened for ${branch}`);
