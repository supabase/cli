#!/usr/bin/env bun
// Generate and optionally publish a user-facing GitHub Release body.
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { $ } from "bun";
import process from "node:process";
import { parseArgs } from "node:util";
import { BunServices } from "@effect/platform-bun";
import { Data, Effect, FileSystem } from "effect";
import * as EffectPath from "effect/Path";

class ProposeReleaseNotesError extends Data.TaggedError("ProposeReleaseNotesError")<{
  readonly operation: string;
  readonly cause: string;
  readonly exitCode?: number;
}> {}

const causeMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const errorMessage = (error: unknown) =>
  error instanceof ProposeReleaseNotesError
    ? `${error.operation}: ${error.cause}`
    : error instanceof Error
      ? error.message
      : String(error);
const runShell = <A>(
  operation: string,
  command: () => PromiseLike<A>,
): Effect.Effect<A, ProposeReleaseNotesError> =>
  Effect.tryPromise({
    try: command,
    catch: (cause) => new ProposeReleaseNotesError({ operation, cause: causeMessage(cause) }),
  });
const logError = (message: string) =>
  Effect.sync(() => {
    process.stderr.write(`${message}\n`);
  });

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

const main = Effect.scoped(
  Effect.gen(function* () {
    const path = yield* EffectPath.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const tag = values.tag;
    if (!tag) {
      return yield* new ProposeReleaseNotesError({
        operation: "validate --tag",
        cause: "--tag is required (e.g. --tag v2.101.0)",
        exitCode: 2,
      });
    }
    const version = tag.replace(/^v/, "");
    const apply = values.apply === true && values["dry-run"] !== true;
    const repoRoot = (yield* runShell("git rev-parse", () =>
      $`git rev-parse --show-toplevel`.text(),
    )).trim();
    const promptPath = path.join(repoRoot, "tools/release/release-notes-prompt.md");
    const backfillScript = path.join(repoRoot, "apps/cli/scripts/backfill-release-notes.ts");
    const notesDir = path.join(repoRoot, "release-notes");
    const notesPath = path.join(notesDir, `v${version}.md`);

    yield* logError(`==> Re-deriving raw semantic-release notes for ${tag}`);
    const rawNotes = (yield* runShell("backfill release notes", () =>
      $`bun ${backfillScript} --tag ${tag}`.cwd(repoRoot).text(),
    )).trim();
    if (!rawNotes) {
      return yield* new ProposeReleaseNotesError({
        operation: "backfill release notes",
        cause: `backfill-release-notes produced no output for ${tag}`,
      });
    }
    const promptTemplate = yield* fileSystem.readFileString(promptPath, "utf8");
    const placeholder = "{{PASTE_SEMANTIC_RELEASE_BLOCK_HERE}}";
    if (!promptTemplate.includes(placeholder)) {
      return yield* new ProposeReleaseNotesError({
        operation: "render prompt",
        cause: `Prompt template at ${promptPath} is missing ${placeholder}`,
      });
    }
    const rendered = promptTemplate.replace(placeholder, rawNotes);
    if (values["render-only"] === true) {
      yield* Effect.sync(() => process.stdout.write(rendered));
      return 0;
    }

    yield* logError(`==> Running Claude Agent SDK (model=${values.model})`);
    const options: Options = {
      model: values.model,
      allowedTools: ["WebFetch", "WebSearch"],
      settingSources: [],
      cwd: repoRoot,
      effort: "low",
    };
    const stream = yield* Effect.try({
      try: () => query({ prompt: rendered, options }),
      catch: (cause) =>
        new ProposeReleaseNotesError({
          operation: "start Claude Agent SDK",
          cause: causeMessage(cause),
        }),
    });
    const iterator = yield* Effect.acquireRelease(
      Effect.try({
        try: () => stream[Symbol.asyncIterator](),
        catch: (cause) =>
          new ProposeReleaseNotesError({
            operation: "open Claude Agent SDK stream",
            cause: causeMessage(cause),
          }),
      }),
      (agentIterator) => {
        if (agentIterator.return === undefined) return Effect.void;
        return runShell("close Claude Agent SDK stream", () => agentIterator.return()).pipe(
          Effect.ignore,
        );
      },
    );
    let finalText = "";
    let cost = 0;
    while (true) {
      const step = yield* runShell("read Claude Agent SDK result", () => iterator.next());
      if (step.done) break;
      const message = step.value;
      if (message.type !== "result") continue;
      if (message.subtype === "success") {
        finalText = message.result;
        cost = message.total_cost_usd;
        continue;
      }
      yield* logError(`Agent failed: ${message.subtype}`);
      if (message.errors?.length) yield* logError(message.errors.join("\n"));
      return yield* new ProposeReleaseNotesError({
        operation: "Claude Agent SDK",
        cause: message.subtype,
      });
    }
    if (!finalText.trim()) {
      return yield* new ProposeReleaseNotesError({
        operation: "Claude Agent SDK",
        cause: "Agent returned no result text",
      });
    }
    const normalized = finalText.endsWith("\n") ? finalText : `${finalText}\n`;
    yield* logError(`==> Agent finished (cost ~$${cost.toFixed(4)})`);
    if (!apply) {
      yield* Effect.sync(() => process.stdout.write(normalized));
      return 0;
    }

    yield* fileSystem.makeDirectory(notesDir, { recursive: true });
    if (yield* fileSystem.exists(notesPath)) {
      return yield* new ProposeReleaseNotesError({
        operation: "write release notes",
        cause:
          `Refusing to overwrite existing ${path.relative(repoRoot, notesPath)}. ` +
          "Delete it or rerun with --dry-run to preview.",
      });
    }
    yield* fileSystem.writeFileString(notesPath, normalized);
    yield* logError(`==> Wrote ${path.relative(repoRoot, notesPath)}`);

    const branch = `release-notes/v${version}`;
    yield* runShell("fetch develop", () =>
      $`git fetch --no-tags origin develop`.cwd(repoRoot).nothrow(),
    );
    yield* runShell("checkout release notes branch", () =>
      $`git checkout -B ${branch} origin/develop`.cwd(repoRoot),
    );
    yield* runShell("stage release notes", () => $`git add ${notesPath}`.cwd(repoRoot));
    yield* runShell("commit release notes", () =>
      $`git commit -m ${`docs(release): propose user-facing notes for ${tag}`}`.cwd(repoRoot),
    );
    yield* logError(`==> Pushing ${branch}`);
    let pushed = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const result = yield* runShell("push release notes", () =>
        $`git push -u origin ${branch}`.cwd(repoRoot).nothrow(),
      );
      if (result.exitCode === 0) {
        pushed = true;
        break;
      }
      const wait = 2 ** (attempt + 1) * 1000;
      yield* logError(`Push failed (attempt ${attempt + 1}/4); retrying in ${wait / 1000}s`);
      yield* Effect.sleep(wait);
    }
    if (!pushed) {
      return yield* new ProposeReleaseNotesError({
        operation: "push release notes",
        cause: "git push failed after 4 attempts",
      });
    }
    const labelName = "do not merge";
    yield* runShell("create release notes label", () =>
      $`gh label create ${labelName} --color B60205 --description ${"Approve to apply; do not merge."} --force`
        .cwd(repoRoot)
        .nothrow(),
    );
    const releaseUrl = `https://github.com/supabase/cli/releases/tag/${tag}`;
    const prBody = `Proposed user-facing release notes for \`${tag}\`, generated by \`apps/cli/scripts/propose-release-notes.ts\` against \`tools/release/release-notes-prompt.md\`.

## How to update the notes

Edit \`release-notes/v${version}.md\` directly on this branch — use the GitHub web editor or push commits to \`${branch}\` — before approving. The applied notes will reflect the file at the approved commit.

## How to publish

Approve this PR as a \`supabase/cli\` team member. The workflow will overwrite the GitHub Release body for [\`${tag}\`](${releaseUrl}), comment the release URL on this PR, close this PR, and delete the \`${branch}\` branch.

**This PR is not merged** — the \`do not merge\` label is a reminder. It targets \`develop\` so an accidental merge never rewrites \`main\`.
`;
    yield* runShell("open release notes PR", () =>
      $`gh pr create --title ${`docs(release): notes for ${tag}`} --body ${prBody} --base develop --head ${branch} --label ${labelName}`.cwd(
        repoRoot,
      ),
    );
    yield* logError(`==> PR opened for ${branch}`);
    return 0;
  }),
);

Effect.runPromise(main.pipe(Effect.provide(BunServices.layer))).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    Effect.runSync(logError(errorMessage(error)));
    process.exitCode = error instanceof ProposeReleaseNotesError ? (error.exitCode ?? 1) : 1;
  },
);
