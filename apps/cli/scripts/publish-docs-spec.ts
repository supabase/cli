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
import { Console, Data, Effect, FileSystem, Layer, Option, Path } from "effect";
import process from "node:process";
import { parseArgs } from "node:util";
import { rootCommand } from "../src/cli/root.ts";
import { buildDocsSidebar, stringifyDocsSidebar } from "../src/docs/docs-sidebar.ts";
import { validateDocsSpec } from "./docs-spec-validation.ts";
import { publishPullRequest } from "./publish-pull-request.ts";
import { writeDocsReference } from "./write-docs-reference.ts";

class StdinReadFailed extends Data.TaggedError("StdinReadFailed")<{ readonly cause: unknown }> {}
class InvalidDestination extends Data.TaggedError("InvalidDestination")<{
  readonly message: string;
}> {}

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    local: { type: "string" },
    repo: { type: "string", default: "supabase/supabase" },
    "spec-path": { type: "string", default: "apps/docs/spec/cli_v1_commands.yaml" },
    "sidebar-path": { type: "string" },
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
      "Usage: bun scripts/generate-docs-spec.ts <version> | bun scripts/publish-docs-spec.ts --version <version> [--repo <owner/repo>] [--spec-path <path>] [--sidebar-path <path>] [--branch <name>] [--base <branch>] [--local <path>] [--dry-run]",
    );
    return yield* Effect.sync(() => process.exit(1));
  }
  const version = versionArgument.startsWith("v") ? versionArgument.slice(1) : versionArgument;

  const repo = values.repo ?? "supabase/supabase";
  const specPath = values["spec-path"] ?? "apps/docs/spec/cli_v1_commands.yaml";
  const sidebarPath =
    values["sidebar-path"] ?? path.join(path.dirname(specPath), "common-cli-sections.json");
  const branch = values.branch ?? "cli/ref-doc";
  const base = values.base ?? "master";
  const dryRun = values["dry-run"] ?? false;
  const localDir = values.local === undefined ? undefined : path.resolve(values.local);

  const isInside = (relative: string) =>
    relative !== "" &&
    relative !== "." &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
  for (const [flag, destination] of [
    ["--spec-path", specPath],
    ["--sidebar-path", sidebarPath],
  ]) {
    if (!destination || !isInside(path.normalize(destination))) {
      return yield* new InvalidDestination({
        message: `Provide a checkout path and a ${flag} inside it.`,
      });
    }
  }
  if (values.local === "") {
    return yield* new InvalidDestination({
      message: "Point --local at an existing supabase/supabase checkout.",
    });
  }
  if (path.resolve(specPath) === path.resolve(sidebarPath)) {
    return yield* new InvalidDestination({
      message: "Refusing to write the spec and sidebar to the same path.",
    });
  }

  const inspectDestinations = Effect.fn("Docs.inspectDestinations")(function* (
    checkoutDir: string,
  ) {
    const checkout = yield* fs.realPath(checkoutDir).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () =>
          Effect.fail(
            new InvalidDestination({
              message: "Point --local at an existing supabase/supabase checkout.",
            }),
          ),
      ),
    );
    const inspect = (relative: string) =>
      Effect.gen(function* () {
        const destination = path.resolve(checkout, relative);
        const parent = yield* fs.realPath(path.dirname(destination));
        if (parent !== checkout && !isInside(path.relative(checkout, parent))) {
          return yield* new InvalidDestination({
            message: `Destination is outside the checkout: ${destination}`,
          });
        }
        const target = path.join(parent, path.basename(destination));
        const info = yield* fs.stat(target).pipe(
          Effect.catchIf(
            (error) => error.reason._tag === "NotFound",
            () => Effect.void,
          ),
        );
        const isSymlink =
          info === undefined
            ? yield* fs.readLink(target).pipe(
                Effect.as(true),
                Effect.catchIf(
                  (error) => error.reason._tag === "NotFound",
                  () => Effect.succeed(false),
                ),
              )
            : (yield* fs.realPath(target)) !== target;
        if (isSymlink) {
          return yield* new InvalidDestination({
            message: `Refusing to write through a symlink: ${target}`,
          });
        }
        if (info !== undefined && info.type !== "File") {
          return yield* new InvalidDestination({ message: `Expected a regular file at ${target}` });
        }
        return { parent, target, info: info ?? undefined };
      });
    const spec = yield* inspect(specPath);
    const sidebar = yield* inspect(sidebarPath);
    if (
      spec.target === sidebar.target ||
      (spec.info !== undefined &&
        sidebar.info !== undefined &&
        spec.info.dev === sidebar.info.dev &&
        Option.isSome(spec.info.ino) &&
        Option.isSome(sidebar.info.ino) &&
        spec.info.ino.value === sidebar.info.ino.value)
    ) {
      return yield* new InvalidDestination({
        message: "Refusing to write the spec and sidebar to the same file.",
      });
    }
    return { spec, sidebar };
  });

  const localDestinations =
    localDir === undefined ? undefined : yield* inspectDestinations(localDir);

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

  const writeReference = Effect.fn("Docs.writeReference")(function* (checkoutDir: string) {
    const destinations = localDestinations ?? (yield* inspectDestinations(checkoutDir));
    yield* writeDocsReference(destinations, spec, sidebar);
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
    Effect.catchTag("InvalidDestination", (error) =>
      Console.error(error.message).pipe(Effect.andThen(Effect.sync(() => process.exit(1)))),
    ),
    Effect.catch((error) => Effect.die(error.cause ?? error)),
  ),
);
