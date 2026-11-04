/**
 * Publishes the generated CLI reference to the docs site by opening a PR against
 * supabase/supabase. Reads the spec on stdin:
 *
 *   bun scripts/generate-docs-spec.ts <version> | bun scripts/publish-docs-spec.ts --version <version>
 *
 * No-op (exit 0) when the spec is already published and no PR is missing; a branch already ahead
 * of base still gets its PR ensured, so a failed prior run is repaired by the next release.
 *
 * `--local <docs checkout> [--version v2|v3] [--prerelease]` instead builds the spec and its
 * sidebar sections in-process and writes both into a local supabase/supabase checkout, where
 * `--version` names the docs major rather than the CLI release.
 */
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { $ } from "bun";
import { Console, Data, Effect, FileSystem, Layer, Path } from "effect";
import process from "node:process";
import { parseArgs } from "node:util";
import { parse } from "yaml";
import { stringifyDocsSections, stringifyDocsSpec } from "../src/docs/docs-spec.ts";
import { loadDocsBundle } from "./docs-bundle.ts";
import { json, publishPullRequest, shell } from "./publish-pull-request.ts";

class StdinReadFailed extends Data.TaggedError("StdinReadFailed")<{ readonly cause: unknown }> {}

class SpecYamlInvalid extends Data.TaggedError("SpecYamlInvalid")<{ readonly cause: unknown }> {}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value)}`;
}

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    repo: { type: "string", default: "supabase/supabase" },
    "spec-path": { type: "string", default: "apps/docs/spec/cli_v2_commands.yaml" },
    branch: { type: "string", default: "cli/ref-doc" },
    base: { type: "string", default: "master" },
    "dry-run": { type: "boolean", default: false },
    local: { type: "string" },
    prerelease: { type: "boolean", default: false },
  },
});

/** The sidebar file the docs site reads for each published CLI major. */
const SECTIONS_FILE_BY_MAJOR: Readonly<Record<string, string>> = {
  v2: "common-cli-sections.json",
  v3: "common-cli-v3-sections.json",
};

const prettierWrite = (prettier: string, target: string) =>
  shell(
    () =>
      $`${prettier} --no-config --single-quote --print-width 100 --log-level warn --write ${target}`,
  );

const publishLocal = (docsRepo: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const major = values.version ?? "v2";
    const sectionsFile = SECTIONS_FILE_BY_MAJOR[major];
    if (sectionsFile === undefined) {
      yield* Console.error(
        `Usage: bun scripts/publish-docs-spec.ts --local <docs checkout> [--version ${Object.keys(SECTIONS_FILE_BY_MAJOR).join("|")}] [--prerelease]`,
      );
      return yield* Effect.sync(() => process.exit(1));
    }
    const specDir = path.join(path.resolve(docsRepo), "apps/docs/spec");
    if (!(yield* fs.exists(specDir))) {
      yield* Console.error(`Refusing to publish: ${specDir} does not exist.`);
      return yield* Effect.sync(() => process.exit(1));
    }

    const bundle = yield* loadDocsBundle({
      version: "latest",
      prerelease: values.prerelease!,
      major: Number(major.slice(1)),
    });
    if (values["dry-run"]) {
      yield* Console.log(
        `Would write ${bundle.spec.commands.length} commands to ${specDir}${bundle.migrationGuide === undefined ? "" : " and the migration guide"}`,
      );
      return;
    }
    const prettier = path.resolve(import.meta.dir, "../node_modules/.bin/prettier");
    const specTarget = path.join(specDir, `cli_${major}_commands.yaml`);
    const sectionsTarget = path.join(specDir, sectionsFile);
    yield* fs.writeFileString(specTarget, stringifyDocsSpec(bundle.spec));
    yield* fs.writeFileString(sectionsTarget, stringifyDocsSections(bundle.sections));
    yield* prettierWrite(prettier, specTarget);
    yield* prettierWrite(prettier, sectionsTarget);
    if (bundle.migrationGuide !== undefined) {
      const guideTarget = path.join(
        path.resolve(docsRepo),
        `apps/docs/docs/ref/cli/${major}/migrating-from-v${Number(major.slice(1)) - 1}.mdx`,
      );
      yield* fs.makeDirectory(path.dirname(guideTarget), { recursive: true });
      yield* fs.writeFileString(guideTarget, bundle.migrationGuide);
      yield* Console.log(`Wrote the migration guide to ${guideTarget}`);
    }
    yield* Console.log(
      `Wrote ${bundle.spec.commands.length} commands to ${specTarget} and ${sectionsTarget}`,
    );
  });

const main = Effect.gen(function* () {
  if (values.local !== undefined) return yield* publishLocal(values.local);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const versionArgument = values.version;
  if (!versionArgument) {
    yield* Console.error(
      "Usage: bun scripts/generate-docs-spec.ts <version> | bun scripts/publish-docs-spec.ts --version <version> [--repo <owner/repo>] [--spec-path <path>] [--branch <name>] [--base <branch>] [--dry-run]\n       bun scripts/publish-docs-spec.ts --local <docs checkout> [--version v2|v3] [--prerelease]",
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
  if (parsed?.clispec !== "002") {
    yield* Console.error(
      `Refusing to publish: expected clispec "002", got ${yield* json(() => jsonText(parsed?.clispec))}.`,
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

  const prettier = path.resolve(import.meta.dir, "../node_modules/.bin/prettier");
  const message = "chore: update cli reference doc";
  yield* publishPullRequest({
    repo,
    base,
    branch,
    stagedPath: specPath,
    write: (checkoutDir) =>
      Effect.gen(function* () {
        const target = path.join(checkoutDir, specPath);
        yield* fs.writeFileString(target, spec);
        yield* prettierWrite(prettier, target);
      }),
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
