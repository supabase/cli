#!/usr/bin/env bun
// Push the contents of release-notes/v<VERSION>.md to the GitHub Release body.
import { $ } from "bun";
import process from "node:process";
import { parseArgs } from "node:util";
import { BunServices } from "@effect/platform-bun";
import { Data, Effect, FileSystem } from "effect";
import * as EffectPath from "effect/Path";

class ApplyReleaseNotesError extends Data.TaggedError("ApplyReleaseNotesError")<{
  readonly operation: string;
  readonly cause: string;
  readonly exitCode?: number;
}> {}

const causeMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const errorMessage = (error: unknown) =>
  error instanceof ApplyReleaseNotesError
    ? `${error.operation}: ${error.cause}`
    : error instanceof Error
      ? error.message
      : String(error);

const runShell = <A>(operation: string, command: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: command,
    catch: (cause) => new ApplyReleaseNotesError({ operation, cause: causeMessage(cause) }),
  });
const logError = (message: string) =>
  Effect.sync(() => {
    process.stderr.write(`${message}\n`);
  });

const { values } = parseArgs({
  options: {
    tag: { type: "string" },
  },
  strict: true,
});

const main = Effect.gen(function* () {
  const path = yield* EffectPath.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const tag = values.tag;
  if (!tag) {
    return yield* new ApplyReleaseNotesError({
      operation: "validate --tag",
      cause: "--tag is required (e.g. --tag v2.101.0)",
      exitCode: 2,
    });
  }
  const version = tag.replace(/^v/, "");
  const repoRoot = (yield* runShell("git rev-parse", () =>
    $`git rev-parse --show-toplevel`.text(),
  )).trim();
  const notesPath = path.join(repoRoot, "release-notes", `v${version}.md`);
  if (!(yield* fileSystem.exists(notesPath))) {
    return yield* new ApplyReleaseNotesError({
      operation: "check release notes",
      cause: `No notes file at ${path.relative(repoRoot, notesPath)}`,
    });
  }
  yield* logError(`==> Updating GitHub Release body for ${tag}`);
  yield* runShell("gh release edit", () =>
    $`gh release edit ${tag} --notes-file ${notesPath}`.cwd(repoRoot),
  );
  yield* logError("==> Done");
});

Effect.runPromise(main.pipe(Effect.provide(BunServices.layer))).then(
  () => {
    process.exitCode = 0;
  },
  (error: unknown) => {
    Effect.runSync(logError(errorMessage(error)));
    process.exitCode = error instanceof ApplyReleaseNotesError ? (error.exitCode ?? 1) : 1;
  },
);
