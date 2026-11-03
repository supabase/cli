#!/usr/bin/env bun
// Generates a user-centric GitHub Release body for a Supabase CLI tag by running the Claude Agent
// SDK against tools/release/release-notes-prompt.md, then opens a PR proposing the notes for
// approval (unless --dry-run or --render-only). See the PR body template below for the approval
// workflow.
//
// Usage: bun apps/cli/scripts/propose-release-notes.ts --tag v2.101.0 [--dry-run] [--apply]
//        [--render-only] [--model <name>]
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { $ } from "bun";
import { Console, Data, Effect, FileSystem, Layer, Path, Stream } from "effect";
import process from "node:process";
import { parseArgs } from "node:util";
import aiModels from "../../../.github/ai-models.json";

class ShellCommandFailed extends Data.TaggedError("ShellCommandFailed")<{
  readonly cause: unknown;
}> {}

class AgentQueryFailed extends Data.TaggedError("AgentQueryFailed")<{ readonly cause: unknown }> {}

const shell = <A>(command: () => Promise<A>) =>
  Effect.tryPromise({ try: command, catch: (cause) => new ShellCommandFailed({ cause }) });

const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });

const { values } = parseArgs({
  options: {
    tag: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    apply: { type: "boolean", default: false },
    "render-only": { type: "boolean", default: false },
    model: { type: "string", default: aiModels.claude.haiku },
  },
  strict: true,
});

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const tag = values.tag;
  if (!tag) {
    yield* Console.error("--tag is required (e.g. --tag v2.101.0)");
    return yield* Effect.sync(() => process.exit(2));
  }
  const version = tag.replace(/^v/, "");
  const apply = values.apply === true && values["dry-run"] !== true;

  const repoRoot = (yield* shell(() => $`git rev-parse --show-toplevel`.text())).trim();
  const promptPath = path.join(repoRoot, "tools/release/release-notes-prompt.md");
  const backfillScript = path.join(repoRoot, "apps/cli/scripts/backfill-release-notes.ts");
  const notesDir = path.join(repoRoot, "release-notes");
  const notesPath = path.join(notesDir, `v${version}.md`);

  yield* Console.error(`==> Re-deriving raw semantic-release notes for ${tag}`);
  const rawNotes = (yield* shell(() =>
    $`bun ${backfillScript} --tag ${tag}`.cwd(repoRoot).text(),
  )).trim();
  if (!rawNotes) {
    yield* Console.error(`backfill-release-notes produced no output for ${tag}`);
    return yield* Effect.sync(() => process.exit(1));
  }

  const promptTemplate = utf8.decode(yield* fs.readFile(promptPath));
  const placeholder = "{{PASTE_SEMANTIC_RELEASE_BLOCK_HERE}}";
  if (!promptTemplate.includes(placeholder)) {
    yield* Console.error(`Prompt template at ${promptPath} is missing ${placeholder}`);
    return yield* Effect.sync(() => process.exit(1));
  }
  const rendered = promptTemplate.replace(placeholder, rawNotes);

  if (values["render-only"]) {
    return yield* Effect.sync(() => {
      process.stdout.write(rendered);
      process.exit(0);
    });
  }

  yield* Console.error(`==> Running Claude Agent SDK (model=${values.model})`);
  const options: Options = {
    model: values.model,
    // WebFetch/WebSearch investigate PR bodies and linked issues; Bash uses `gh` for
    // authenticated GitHub queries instead of HTML scraping. Edit/Write are excluded — the
    // script owns the final file output.
    allowedTools: ["WebFetch", "WebSearch", "Bash"],
    // Skips the repo's CLAUDE.md and settings.json — the prompt is self-contained.
    settingSources: [],
    cwd: repoRoot,
    effort: "low",
  };

  let finalText = "";
  let cost = 0;
  yield* Stream.fromAsyncIterable(
    query({ prompt: rendered, options }),
    (cause) => new AgentQueryFailed({ cause }),
  ).pipe(
    Stream.runForEach((msg) =>
      Effect.gen(function* () {
        if (msg.type === "result") {
          if (msg.subtype === "success") {
            finalText = msg.result;
            cost = msg.total_cost_usd;
          } else {
            yield* Console.error(`Agent failed: ${msg.subtype}`);
            if (msg.errors?.length) yield* Console.error(msg.errors.join("\n"));
            return yield* Effect.sync(() => process.exit(1));
          }
        }
      }),
    ),
  );

  if (!finalText.trim()) {
    yield* Console.error("Agent returned no result text");
    return yield* Effect.sync(() => process.exit(1));
  }

  const normalized = finalText.endsWith("\n") ? finalText : `${finalText}\n`;
  yield* Console.error(`==> Agent finished (cost ~$${cost.toFixed(4)})`);

  if (!apply) {
    return yield* Effect.sync(() => {
      process.stdout.write(normalized);
      process.exit(0);
    });
  }

  yield* fs.makeDirectory(notesDir, { recursive: true });
  if (yield* fs.exists(notesPath).pipe(Effect.orElseSucceed(() => false))) {
    yield* Console.error(
      `Refusing to overwrite existing ${path.relative(repoRoot, notesPath)}. ` +
        `Delete it or rerun with --dry-run to preview.`,
    );
    return yield* Effect.sync(() => process.exit(1));
  }
  yield* fs.writeFileString(notesPath, normalized);
  yield* Console.error(`==> Wrote ${path.relative(repoRoot, notesPath)}`);

  const branch = `release-notes/v${version}`;
  // Branches from origin/develop, not the checked-out ref, so a feature branch that has diverged
  // doesn't drag its commits into the PR; the notes file is untracked, so this leaves it in place.
  // Targets develop rather than main so an accidental merge can't rewrite main's history.
  yield* shell(() => $`git fetch --no-tags origin develop`.cwd(repoRoot).nothrow());
  yield* shell(() => $`git checkout -B ${branch} origin/develop`.cwd(repoRoot));
  yield* shell(() => $`git add ${notesPath}`.cwd(repoRoot));
  const commitMessage = `docs(release): propose user-facing notes for ${tag}`;
  yield* shell(() => $`git commit -m ${commitMessage}`.cwd(repoRoot));

  yield* Console.error(`==> Pushing ${branch}`);
  let pushed = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    const result = yield* shell(() => $`git push -u origin ${branch}`.cwd(repoRoot).nothrow());
    if (result.exitCode === 0) {
      pushed = true;
      break;
    }
    const wait = 2 ** (attempt + 1) * 1000;
    yield* Console.error(`Push failed (attempt ${attempt + 1}/4); retrying in ${wait / 1000}s`);
    yield* Effect.sleep(wait);
  }
  if (!pushed) {
    yield* Console.error("git push failed after 4 attempts");
    return yield* Effect.sync(() => process.exit(1));
  }

  // Ensures the `do not merge` label exists before attaching it — a reminder for reviewers; the
  // approval workflow never actually merges.
  const labelName = "do not merge";
  yield* shell(() =>
    $`gh label create ${labelName} --color B60205 --description ${"Approve to apply; do not merge."} --force`
      .cwd(repoRoot)
      .nothrow(),
  );

  const releaseUrl = `https://github.com/supabase/cli/releases/tag/${tag}`;
  const prBody = `Proposed user-facing release notes for \`${tag}\`, generated by \`apps/cli/scripts/propose-release-notes.ts\` against \`tools/release/release-notes-prompt.md\`.

## How to update the notes

Edit \`release-notes/v${version}.md\` directly on this branch — use the GitHub web editor or push commits to \`${branch}\` — before approving. The applied notes will reflect the file at the approved commit.

## How to publish

Approve this PR as a \`supabase/cli\` team member. The \`.github/workflows/apply-release-notes.yml\` workflow will then:

1. Overwrite the GitHub Release body for [\`${tag}\`](${releaseUrl}) with the contents of \`release-notes/v${version}.md\`.
2. Comment the release URL on this PR.
3. Close this PR and delete the \`${branch}\` branch.

**This PR is not merged** — the \`do not merge\` label is a reminder. It targets \`develop\` so that even an accidental merge never rewrites \`main\`. Nothing is meant to land on any branch.

Approvals from anyone outside the \`supabase/cli\` team are ignored; the workflow will post a comment explaining that and leave the release untouched.

## How to abandon

Close the PR without approving. The auto-generated semantic-release body for \`${tag}\` stays in place.

## Re-generation

After this PR is closed, rerun the **Propose release notes** workflow from the Actions tab against \`${tag}\` to get a fresh proposal.
`;

  yield* shell(() =>
    $`gh pr create --title ${`docs(release): notes for ${tag}`} --body ${prBody} --base develop --head ${branch} --label ${labelName}`.cwd(
      repoRoot,
    ),
  );
  yield* Console.error(`==> PR opened for ${branch}`);
});

function thrownValue(error: { readonly message: string; readonly cause?: unknown }): unknown {
  return error.cause !== undefined ? error.cause : new Error(error.message);
}

await Effect.runPromise(
  main.pipe(
    Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
    Effect.catch((error) => Effect.die(thrownValue(error))),
  ),
);
