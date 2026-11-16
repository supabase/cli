/**
 * Publishes the generated CLI reference to the docs site by opening a PR against
 * supabase/supabase, or writes it to a local checkout with --local. Reads the spec on stdin:
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
import { json, publishPullRequest, shell } from "./publish-pull-request.ts";

class StdinReadFailed extends Data.TaggedError("StdinReadFailed")<{ readonly cause: unknown }> {}

class SpecYamlInvalid extends Data.TaggedError("SpecYamlInvalid")<{ readonly cause: unknown }> {}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value)}`;
}

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    local: { type: "string" },
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
      "Usage: bun scripts/generate-docs-spec.ts <version> | bun scripts/publish-docs-spec.ts --version <version> [--repo <owner/repo>] [--spec-path <path>] [--branch <name>] [--base <branch>] [--local <path>] [--dry-run]",
    );
    return yield* Effect.sync(() => process.exit(1));
  }
  const version = versionArgument.startsWith("v") ? versionArgument.slice(1) : versionArgument;

  const repo = values.repo ?? "supabase/supabase";
  const specPath = values["spec-path"] ?? "apps/docs/spec/cli_v1_commands.yaml";
  const branch = values.branch ?? "cli/ref-doc";
  const base = values.base ?? "master";
  const dryRun = values["dry-run"] ?? false;
  const localDir = values.local === undefined ? undefined : path.resolve(values.local);

  if (localDir !== undefined) {
    const relativeTarget = path.relative(localDir, path.resolve(localDir, specPath));
    if (
      values.local === "" ||
      path.isAbsolute(specPath) ||
      relativeTarget === ".." ||
      relativeTarget.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeTarget)
    ) {
      yield* Console.error(
        "Refusing local preview: provide a checkout path and a --spec-path inside it.",
      );
      return yield* Effect.sync(() => process.exit(1));
    }
    if (!(yield* fs.exists(path.join(localDir, path.dirname(specPath))))) {
      yield* Console.error(
        "Refusing local preview: the spec directory does not exist. Point --local at an existing supabase/supabase checkout.",
      );
      return yield* Effect.sync(() => process.exit(1));
    }
  }

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
      localDir === undefined
        ? `Would publish ${spec.length} bytes to ${repo}:${specPath} on branch ${branch}`
        : `Would write ${spec.length} bytes to ${path.join(localDir, specPath)}`,
    );
    return yield* Effect.sync(() => process.exit(0));
  }

  const prettier = path.resolve(import.meta.dir, "../node_modules/.bin/prettier");
  const writeSpec = Effect.fn("Docs.writeSpec")(function* (checkoutDir: string) {
    const target = path.join(checkoutDir, specPath);
    yield* fs.writeFileString(target, spec);
    yield* shell(
      () =>
        $`${prettier} --no-config --single-quote --print-width 100 --log-level warn --write ${target}`,
    );
    yield* Effect.annotateCurrentSpan("docs.commands.count", commands.length);
  });

  if (localDir !== undefined) {
    yield* writeSpec(localDir);
    yield* Console.log(`Wrote CLI reference to ${path.join(localDir, specPath)}`);
    return;
  }

  const message = "chore: update cli reference doc";
  yield* publishPullRequest({
    repo,
    base,
    branch,
    stagedPath: specPath,
    write: writeSpec,
    commitMessage: message,
    pullRequestTitle: message,
    pullRequestBody: [
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
    ].join("\n"),
    autoMerge: false,
  });
});

await Effect.runPromise(
  main.pipe(
    Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
    Effect.catch((error) => Effect.die(error.cause ?? error)),
  ),
);
