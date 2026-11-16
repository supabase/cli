#!/usr/bin/env bun
// Push the contents of release-notes/v<VERSION>.md to the GitHub Release body
// for tag v<VERSION>. Invoked from apply-release-notes.yml after a
// release-notes PR is merged to main.
//
// Usage:
//   bun apps/cli/scripts/apply-release-notes.ts --tag v2.101.0
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { $ } from "bun";
import { Console, Data, Effect, FileSystem, Layer, Path } from "effect";
import process from "node:process";
import { parseArgs } from "node:util";

class ShellCommandFailed extends Data.TaggedError("ShellCommandFailed")<{
  readonly cause: unknown;
}> {}

const shell = <A>(command: () => Promise<A>) =>
  Effect.tryPromise({ try: command, catch: (cause) => new ShellCommandFailed({ cause }) });

const { values } = parseArgs({
  options: {
    tag: { type: "string" },
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

  const repoRoot = (yield* shell(() => $`git rev-parse --show-toplevel`.text())).trim();
  const notesPath = path.join(repoRoot, "release-notes", `v${version}.md`);
  if (!(yield* fs.exists(notesPath).pipe(Effect.orElseSucceed(() => false)))) {
    yield* Console.error(`No notes file at ${path.relative(repoRoot, notesPath)}`);
    return yield* Effect.sync(() => process.exit(1));
  }

  yield* Console.error(`==> Updating GitHub Release body for ${tag}`);
  yield* shell(() => $`gh release edit ${tag} --notes-file ${notesPath}`.cwd(repoRoot));
  yield* Console.error(`==> Done`);
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
