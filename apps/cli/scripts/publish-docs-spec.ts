/**
 * Publishes the generated CLI reference to the docs site by opening a PR against
 * supabase/supabase. Reads the spec on stdin:
 *
 *   bun scripts/generate-docs-spec.ts <version> | bun scripts/publish-docs-spec.ts --version <version>
 *
 * No-op (exit 0) when the spec is already published and no PR is missing; a branch already ahead
 * of base still gets its PR ensured, so a failed prior run is repaired by the next release.
 */
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { $ } from "bun";
import { Console, Data, Effect, FileSystem, Layer, Path } from "effect";
import process from "node:process";
import { parseArgs } from "node:util";
import { parse } from "yaml";

class ShellCommandFailed extends Data.TaggedError("ShellCommandFailed")<{
  readonly cause: unknown;
}> {}

class StdinReadFailed extends Data.TaggedError("StdinReadFailed")<{ readonly cause: unknown }> {}

class SpecYamlInvalid extends Data.TaggedError("SpecYamlInvalid")<{ readonly cause: unknown }> {}

class JsonFailed extends Data.TaggedError("JsonFailed")<{ readonly cause: unknown }> {}

const shell = <A>(command: () => Promise<A>) =>
  Effect.tryPromise({ try: command, catch: (cause) => new ShellCommandFailed({ cause }) });

/* Plain `JSON` keeps the engine's own error for a cyclic spec value or malformed `gh` output,
   which a `Schema` codec would replace with its issue text. */
const json = <A>(run: () => A) =>
  Effect.try({ try: run, catch: (cause) => new JsonFailed({ cause }) });

function jsonText(value: unknown): string {
  return `${JSON.stringify(value)}`;
}

function ownPullsOf(existing: string, repo: string) {
  const openPulls: Array<{ headRepositoryOwner?: { login?: string } }> = JSON.parse(existing);
  return openPulls.filter(
    (pull) => pull.headRepositoryOwner?.login?.toLowerCase() === repo.split("/")[0]?.toLowerCase(),
  );
}

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    repo: { type: "string", default: "supabase/supabase" },
    "spec-path": { type: "string", default: "apps/docs/spec/cli_v1_commands.yaml" },
    branch: { type: "string", default: "cli/ref-doc" },
    base: { type: "string", default: "master" },
    "dry-run": { type: "boolean", default: false },
  },
});

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const versionArgument = values.version;
  if (!versionArgument) {
    yield* Console.error(
      "Usage: bun scripts/generate-docs-spec.ts <version> | bun scripts/publish-docs-spec.ts --version <version> [--repo <owner/repo>] [--spec-path <path>] [--branch <name>] [--base <branch>] [--dry-run]",
    );
    return yield* Effect.sync(() => process.exit(1));
  }
  const version = versionArgument.startsWith("v") ? versionArgument.slice(1) : versionArgument;

  const repo = values.repo!;
  const specPath = values["spec-path"]!;
  const branch = values.branch!;
  const base = values.base!;
  const dryRun = values["dry-run"]!;

  const spec = yield* Effect.tryPromise({
    try: () => Bun.stdin.text(),
    catch: (cause) => new StdinReadFailed({ cause }),
  });
  if (spec.trim().length === 0) {
    yield* Console.error("Refusing to publish an empty spec: nothing was piped in on stdin.");
    return yield* Effect.sync(() => process.exit(1));
  }

  const parsed: { clispec?: unknown; info?: { version?: unknown }; commands?: unknown } =
    yield* Effect.try({
      try: () => parse(spec),
      catch: (cause) => new SpecYamlInvalid({ cause }),
    }).pipe(
      Effect.catch((error) =>
        Console.error(`Refusing to publish: stdin is not valid YAML (${error.cause}).`).pipe(
          Effect.andThen(Effect.sync(() => process.exit(1))),
        ),
      ),
    );
  if (parsed?.clispec !== "001") {
    yield* Console.error(
      `Refusing to publish: expected clispec "001", got ${yield* json(() => jsonText(parsed?.clispec))}.`,
    );
    return yield* Effect.sync(() => process.exit(1));
  }
  if (parsed.info?.version !== version) {
    yield* Console.error(
      `Refusing to publish: the spec's version ${yield* json(() => jsonText(parsed.info?.version))} does not match --version ${version}.`,
    );
    return yield* Effect.sync(() => process.exit(1));
  }
  const commands = parsed.commands;
  if (!Array.isArray(commands) || commands.length < 144) {
    yield* Console.error(
      `Refusing to publish: the spec has ${Array.isArray(commands) ? commands.length : 0} commands, expected at least 144.`,
    );
    return yield* Effect.sync(() => process.exit(1));
  }

  if (dryRun) {
    yield* Console.log(
      `Would publish ${spec.length} bytes to ${repo}:${specPath} on branch ${branch}`,
    );
    return yield* Effect.sync(() => process.exit(0));
  }

  // `--depth 1` suffices: an existing `cli/ref-doc` branch is fetched at its tip and the new spec
  // lands as one commit on top, so commits pushed onto an open PR survive later releases.
  const publishSpec = (tmpDir: string) =>
    Effect.gen(function* () {
      yield* shell(
        () =>
          $`git clone --quiet --depth 1 --branch ${base} https://github.com/${repo}.git ${tmpDir}`,
      );

      const remoteBranch = yield* shell(() =>
        $`git -C ${tmpDir} fetch --quiet --depth 1 origin ${branch}`.nothrow().quiet(),
      );
      if (remoteBranch.exitCode === 0) {
        yield* shell(() => $`git -C ${tmpDir} checkout --quiet -B ${branch} FETCH_HEAD`);
      } else {
        yield* shell(() => $`git -C ${tmpDir} checkout --quiet -B ${branch}`);
      }

      const target = path.join(tmpDir, specPath);
      yield* fs.writeFileString(target, spec);
      const prettier = path.resolve(import.meta.dir, "../node_modules/.bin/prettier");
      yield* shell(
        () =>
          $`${prettier} --no-config --single-quote --print-width 100 --log-level warn --write ${target}`,
      );

      const message = "chore: update cli reference doc";
      yield* shell(() => $`git -C ${tmpDir} add ${specPath}`);
      const unchanged = yield* shell(() =>
        $`git -C ${tmpDir} diff --quiet --cached -- ${specPath}`.nothrow().quiet(),
      );
      if (unchanged.exitCode === 0) {
        yield* Console.log(
          remoteBranch.exitCode === 0
            ? `${specPath} is already up to date on ${branch}`
            : `${specPath} is already up to date in ${repo}`,
        );
      } else {
        yield* shell(
          () =>
            $`git -C ${tmpDir} -c ${"user.name=github-actions[bot]"} -c ${"user.email=41898282+github-actions[bot]@users.noreply.github.com"} commit --quiet -m ${message}`,
        );
        yield* shell(() => $`git -C ${tmpDir} push --quiet origin ${branch}`);
        yield* Console.log(`Pushed ${branch} to ${repo}`);
      }

      const unpublished = yield* shell(() =>
        $`git -C ${tmpDir} diff --quiet origin/${base} HEAD -- ${specPath}`.nothrow().quiet(),
      );
      if (unpublished.exitCode === 1) {
        const existing = yield* shell(() =>
          $`gh pr list --repo ${repo} --head ${branch} --base ${base} --state open --json number,headRepositoryOwner`
            .cwd(tmpDir)
            .text(),
        );
        const ownPulls = yield* json(() => ownPullsOf(existing, repo));
        if (ownPulls.length > 0) {
          yield* Console.log(`Reusing the open PR for ${branch}`);
        } else {
          const body = [
            "Updates the CLI reference from the supabase/cli release workflow.",
            "",
            "Generated by `scripts/generate-docs-spec.ts` in supabase/cli — edit the",
            "command tree or the content under `apps/cli/docs/` there rather than this",
            "file.",
            "",
            "New commands also need an entry in `apps/docs/spec/common-cli-sections.json` —",
            "without one a command's page is silently dropped from the docs site.",
            "Sections fixes can be committed directly onto this branch — later releases",
            "add commits on top instead of rewriting it.",
          ].join("\n");
          yield* shell(() =>
            $`gh pr create --repo ${repo} --title ${message} --body ${body} --base ${base} --head ${branch}`.cwd(
              tmpDir,
            ),
          );
          yield* Console.log(`Opened a pull request against ${repo}`);
        }
      }
    });
  /* A failed removal replaces the run's outcome. */
  yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const tmpDir = yield* fs.makeTempDirectory({ prefix: "supabase-docs-" });
      const outcome = yield* Effect.exit(restore(publishSpec(tmpDir)));
      yield* fs.remove(tmpDir, { recursive: true, force: true });
      return yield* outcome;
    }),
  );
});

await Effect.runPromise(
  main.pipe(
    Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
    Effect.catch((error) => Effect.die(error.cause ?? error)),
  ),
);
