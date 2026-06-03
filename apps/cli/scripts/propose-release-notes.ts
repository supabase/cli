#!/usr/bin/env bun
// Generate a user-centric GitHub Release body for a Supabase CLI tag
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
//      `release-notes/v<VERSION>` and opens a PR. Approving the PR (as a
//      supabase/cli team member) triggers apply-release-notes.yml, which
//      pushes the file's contents to the GH release body and closes the PR
//      without merging — the file never lands on `main`.
//
// Usage:
//   bun apps/cli/scripts/propose-release-notes.ts --tag v2.101.0 --dry-run
//   bun apps/cli/scripts/propose-release-notes.ts --tag v2.101.0 --apply
//
//   --tag      Required. Release tag (e.g. v2.101.0 or v2.99.0-beta.1).
//   --dry-run  Print the proposed notes to stdout. Does not write any files,
//              does not touch git.
//   --apply    Write release-notes/v<VERSION>.md, commit on a branch, push,
//              and open a PR. Default behavior when neither flag is passed
//              is `--dry-run`.
//   --render-only  Print the rendered prompt (template + raw notes block)
//              and exit before any LLM call. Useful for prompt iteration
//              and for verifying the pipeline shape without spending tokens.
//   --model    Optional. Override the Claude model (default: claude-haiku-4-5-20251001).
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
    model: { type: "string", default: "claude-haiku-4-5-20251001" },
  },
  strict: true,
});

const tag = values.tag;
if (!tag) {
  console.error("--tag is required (e.g. --tag v2.101.0)");
  process.exit(2);
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
  // Don't load the repo's CLAUDE.md or settings.json — the prompt is
  // self-contained and we don't want unrelated agent context bleeding in.
  settingSources: [],
  cwd: repoRoot,
  effort: "low",
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

// Append the raw notes to the final text to ensure the output is complete.
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

// Idempotently ensure the `do not merge` label exists on the repo, then attach
// it on PR creation. The label is a visual reminder for reviewers — the
// approval-based apply workflow never invokes the merge button — but the
// publish flow itself does not depend on it.
const labelName = "do not merge";
await $`gh label create ${labelName} --color B60205 --description ${"Approve to apply; do not merge."} --force`
  .cwd(repoRoot)
  .nothrow();

const releaseUrl = `https://github.com/supabase/cli/releases/tag/${tag}`;
const prBody = `Proposed user-facing release notes for \`${tag}\`, generated by \`apps/cli/scripts/propose-release-notes.ts\` against \`tools/release/release-notes-prompt.md\`.

## How to update the notes

Edit \`release-notes/v${version}.md\` directly on this branch — use the GitHub web editor or push commits to \`${branch}\` — before approving. The applied notes will reflect the file at the approved commit.

## How to publish

Approve this PR as a \`supabase/cli\` team member. The \`.github/workflows/apply-release-notes.yml\` workflow will then:

1. Overwrite the GitHub Release body for [\`${tag}\`](${releaseUrl}) with the contents of \`release-notes/v${version}.md\`.
2. Comment the release URL on this PR.
3. Close this PR and delete the \`${branch}\` branch.

**This PR is not merged** — the \`do not merge\` label is a reminder. Nothing lands on \`main\`.

Approvals from anyone outside the \`supabase/cli\` team are ignored; the workflow will post a comment explaining that and leave the release untouched.

## How to abandon

Close the PR without approving. The auto-generated semantic-release body for \`${tag}\` stays in place.

## Re-generation

After this PR is closed, rerun the **Propose release notes** workflow from the Actions tab against \`${tag}\` to get a fresh proposal.
`;

await $`gh pr create --title ${`docs(release): notes for ${tag}`} --body ${prBody} --base main --head ${branch} --label ${labelName}`.cwd(
  repoRoot,
);
console.error(`==> PR opened for ${branch}`);
