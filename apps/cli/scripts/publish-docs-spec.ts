/**
 * Publishes the generated CLI reference to the docs site by opening a PR against
 * supabase/supabase, or writes it to a local checkout with --local. Reads the spec on stdin:
 *
 *   bun scripts/generate-docs-spec.ts <version> | bun scripts/publish-docs-spec.ts --version <version>
 *
 * No-op (exit 0) when both files are already published and no PR is missing; a branch already ahead
 * of base still gets its PR ensured, so a failed prior run is repaired by the next release.
 */
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { $ } from "bun";
import { Console, Data, Effect, FileSystem, Layer, Path } from "effect";
import process from "node:process";
import { parseArgs } from "node:util";
import { rootCommand } from "../src/cli/root.ts";
import { buildDocsSidebar, stringifyDocsSidebar } from "../src/docs/docs-sidebar.ts";
import { validateDocsSpec } from "./docs-spec-validation.ts";
import { publishPullRequest, shell } from "./publish-pull-request.ts";

class StdinReadFailed extends Data.TaggedError("StdinReadFailed")<{ readonly cause: unknown }> {}

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
  const sidebarPath = "apps/docs/spec/common-cli-sections.json";
  const branch = values.branch ?? "cli/ref-doc";
  const base = values.base ?? "master";
  const dryRun = values["dry-run"] ?? false;
  const localDir = values.local === undefined ? undefined : path.resolve(values.local);

  if (path.resolve(specPath) === path.resolve(sidebarPath)) {
    yield* Console.error("Refusing to write the spec and sidebar to the same path.");
    return yield* Effect.sync(() => process.exit(1));
  }

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
    const specDirExists = yield* fs.exists(path.join(localDir, path.dirname(specPath)));
    const sidebarDirExists = yield* fs.exists(path.join(localDir, path.dirname(sidebarPath)));
    if (!specDirExists || !sidebarDirExists) {
      yield* Console.error(
        "Refusing local preview: the spec or sidebar directory does not exist. Point --local at an existing supabase/supabase checkout.",
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

  const { commands } = yield* validateDocsSpec(spec, version, rootCommand).pipe(
    Effect.catch((error) =>
      Console.error(`Refusing to publish: ${error.message}`).pipe(
        Effect.andThen(Effect.sync(() => process.exit(1))),
      ),
    ),
  );

  const sidebar = yield* Effect.try(() => stringifyDocsSidebar(buildDocsSidebar(rootCommand)));

  if (dryRun) {
    yield* Console.log(
      localDir === undefined
        ? `Would publish ${specPath} and ${sidebarPath} to ${repo} on branch ${branch}`
        : `Would write ${path.join(localDir, specPath)} and ${path.join(localDir, sidebarPath)}`,
    );
    return yield* Effect.sync(() => process.exit(0));
  }

  const prettier = path.resolve(import.meta.dir, "../node_modules/.bin/prettier");
  const writeReference = Effect.fn("Docs.writeReference")(function* (checkoutDir: string) {
    const target = path.join(checkoutDir, specPath);
    yield* fs.writeFileString(target, spec);
    yield* shell(
      () =>
        $`${prettier} --no-config --single-quote --print-width 100 --log-level warn --write ${target}`,
    );
    yield* fs.writeFileString(path.join(checkoutDir, sidebarPath), `${sidebar}\n`);
    yield* Effect.annotateCurrentSpan("docs.commands.count", commands.length);
  });

  if (localDir !== undefined) {
    yield* writeReference(localDir);
    yield* Console.log(
      `Wrote CLI reference to ${path.join(localDir, specPath)} and ${path.join(localDir, sidebarPath)}`,
    );
    return;
  }

  const message = "chore: update cli reference doc";
  yield* publishPullRequest({
    repo,
    base,
    branch,
    stagedPaths: [specPath, sidebarPath],
    write: writeReference,
    commitMessage: message,
    pullRequestTitle: message,
    pullRequestBody: [
      "Updates the CLI reference from the supabase/cli release workflow.",
      "",
      "The command spec and sidebar are generated from the same CLI command tree.",
      "For changes, edit the command tree or the content under `apps/cli/docs/` in supabase/cli.",
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
