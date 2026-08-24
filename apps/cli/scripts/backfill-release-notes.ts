#!/usr/bin/env bun
// Re-derive a GitHub Release's changelog from a historical tag using the
// current semantic-release configuration.
import { $ } from "bun";
import process from "node:process";
import { parseArgs } from "node:util";
import { BunServices } from "@effect/platform-bun";
import { ConfigProvider, Data, Effect, FileSystem, Schema } from "effect";
import * as EffectPath from "effect/Path";
import semanticRelease, { type Result as SemanticReleaseResult } from "semantic-release";

class BackfillError extends Data.TaggedError("BackfillError")<{
  readonly operation: string;
  readonly cause: string;
  readonly exitCode?: number;
}> {}

const causeMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const errorMessage = (error: unknown) =>
  error instanceof BackfillError
    ? `${error.operation}: ${error.cause}`
    : error instanceof Error
      ? error.message
      : String(error);

const runShell = <A>(
  operation: string,
  command: () => PromiseLike<A>,
): Effect.Effect<A, BackfillError> =>
  Effect.tryPromise({
    try: command,
    catch: (cause) => new BackfillError({ operation, cause: causeMessage(cause) }),
  });

const runForeign = <A>(
  operation: string,
  operationEffect: () => PromiseLike<A>,
): Effect.Effect<A, BackfillError> =>
  Effect.tryPromise({
    try: operationEffect,
    catch: (cause) => new BackfillError({ operation, cause: causeMessage(cause) }),
  });
const logError = (message: string) =>
  Effect.sync(() => {
    process.stderr.write(`${message}\n`);
  });

const collectEnvironment = (
  provider: ConfigProvider.ConfigProvider,
  path: ConfigProvider.Path = [],
): Effect.Effect<ReadonlyArray<readonly [string, string]>, ConfigProvider.SourceError> =>
  Effect.gen(function* () {
    const node = yield* provider.load(path);
    if (node === undefined) return [];
    const prefix = path.join("_");
    const entry = (value: string): readonly [string, string] => [prefix, value];
    const own = node._tag === "Value" || node.value === undefined ? [] : [entry(node.value)];
    if (node._tag === "Value") return [entry(node.value)];
    const children =
      node._tag === "Record"
        ? [...node.keys]
        : Array.from({ length: node.length }, (_, index) => String(index));
    const nested = yield* Effect.forEach(
      children,
      (child) => collectEnvironment(provider, [...path, child]),
      {
        concurrency: "unbounded",
      },
    );
    return [...own, ...nested.flat()];
  });

const PackageJsonSchema = Schema.Record(Schema.String, Schema.Json);
const ReleaseNotePayload = Schema.Struct({ channels: Schema.Array(Schema.String) });
type PackageJson = Schema.Schema.Type<typeof PackageJsonSchema>;
const isJsonObject = (value: Schema.Json): value is Schema.JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const { values } = parseArgs({
  options: {
    tag: { type: "string" },
    apply: { type: "boolean", default: false },
  },
  strict: true,
});

const main = Effect.scoped(
  Effect.gen(function* () {
    const path = yield* EffectPath.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const tag = values.tag;
    if (!tag) {
      return yield* new BackfillError({
        operation: "validate --tag",
        cause: "--tag is required (e.g. --tag v2.99.0-beta.1)",
        exitCode: 2,
      });
    }
    const apply = values.apply === true;
    const repoRoot = (yield* runShell("git rev-parse", () =>
      $`git rev-parse --show-toplevel`.text(),
    )).trim();
    const cliDir = path.join(repoRoot, "apps/cli");
    const decodePackage = (filePath: string): Effect.Effect<PackageJson, BackfillError> =>
      fileSystem.readFileString(filePath, "utf8").pipe(
        Effect.flatMap((contents) =>
          Schema.decodeEffect(Schema.fromJsonString(PackageJsonSchema))(contents),
        ),
        Effect.mapError(
          (cause) =>
            new BackfillError({ operation: `read ${filePath}`, cause: causeMessage(cause) }),
        ),
      );
    const rootPkg = yield* decodePackage(path.join(cliDir, "package.json"));
    const repoField = rootPkg.repository;
    const repoUrlBase =
      repoField === undefined
        ? ""
        : typeof repoField === "string"
          ? repoField
          : isJsonObject(repoField) && typeof repoField.url === "string"
            ? repoField.url
            : "";
    const repoUrl = `${repoUrlBase
      .replace(/^git\+/, "")
      .replace(/\.git$/, "")
      .replace(/\/$/, "")}.git`;
    if (!repoUrl.startsWith("http")) {
      return yield* new BackfillError({
        operation: "derive repository URL",
        cause: `Could not derive repository URL from apps/cli/package.json (got: ${repoUrl})`,
      });
    }

    const tagCheck = yield* runShell("check local tag", () =>
      $`git rev-parse -q --verify refs/tags/${tag}`.cwd(repoRoot).nothrow().quiet(),
    );
    if (tagCheck.exitCode !== 0) {
      return yield* new BackfillError({
        operation: "check local tag",
        cause: `Tag ${tag} not found locally. Try: git fetch --tags origin`,
      });
    }

    const branch = tag.includes("-beta.") ? "develop" : "main";
    const work = yield* Effect.acquireRelease(
      fileSystem.makeTempDirectory({ prefix: "backfill-release-notes." }),
      (directory) =>
        fileSystem.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore),
    );
    const clone = path.join(work, "repo");
    yield* logError(`==> Cloning ${repoRoot} -> ${clone}`);
    yield* runShell("clone repository", () => $`git clone --quiet --no-local ${repoRoot} ${clone}`);
    yield* runShell(
      "configure clone identity",
      () => $`git -C ${clone} config --local user.email backfill-release-notes@supabase.local`,
    );
    yield* runShell(
      "configure clone identity",
      () => $`git -C ${clone} config --local user.name backfill-release-notes`,
    );
    yield* runShell(
      "disable commit signing",
      () => $`git -C ${clone} config --local commit.gpgsign false`,
    );
    yield* runShell(
      "disable tag signing",
      () => $`git -C ${clone} config --local tag.gpgsign false`,
    );

    const originUrl = (yield* runShell("read origin URL", () =>
      $`git -C ${repoRoot} remote get-url origin`.text(),
    )).trim();
    yield* runShell("fetch local notes", () =>
      $`git -C ${clone} fetch --no-tags --quiet ${repoRoot} +refs/notes/*:refs/notes/*`
        .nothrow()
        .quiet(),
    );
    yield* runShell("fetch remote notes", () =>
      $`git -C ${clone} fetch --no-tags --quiet ${originUrl} +refs/notes/*:refs/notes/*`
        .nothrow()
        .quiet(),
    );
    yield* runShell("fetch remote branches", () =>
      $`git -C ${clone} fetch --no-tags --quiet ${originUrl} +refs/heads/main:refs/remotes/origin/main +refs/heads/develop:refs/remotes/origin/develop`
        .nothrow()
        .quiet(),
    );

    const sha = (yield* runShell("resolve tag commit", () =>
      $`git -C ${clone} rev-list -n 1 ${tag}`.text(),
    )).trim();
    const coincidentTagsOut = yield* runShell("find coincident tags", () =>
      $`git -C ${clone} tag --points-at ${sha}`.text(),
    );
    for (const coincidentTag of coincidentTagsOut
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean)) {
      yield* runShell("remove coincident tag", () =>
        $`git -C ${clone} tag -d ${coincidentTag}`.quiet().nothrow(),
      );
    }
    yield* runShell(
      "checkout historical tag",
      () => $`git -C ${clone} checkout -B ${branch} ${sha} --quiet`,
    );

    for (const configuredBranch of ["main", "develop"]) {
      if (configuredBranch === branch) continue;
      const refSha = yield* runShell("resolve remote branch", () =>
        $`git -C ${clone} rev-parse --verify -q refs/remotes/origin/${configuredBranch}`
          .nothrow()
          .quiet(),
      );
      if (refSha.exitCode === 0) {
        yield* runShell(
          "seed local branch",
          () =>
            $`git -C ${clone} update-ref refs/heads/${configuredBranch} ${refSha.text().trim()}`,
        );
      }
    }

    const mergedTagsOut = yield* runShell("list merged tags", () =>
      $`git -C ${clone} tag --merged HEAD --sort=v:refname`.text(),
    );
    for (const previousTag of mergedTagsOut.split("\n").filter((value) => value && value !== tag)) {
      const noteCheck = yield* runShell("check release note", () =>
        $`git -C ${clone} notes --ref semantic-release show ${previousTag}`.nothrow().quiet(),
      );
      if (noteCheck.exitCode === 0) continue;
      const channel = previousTag.includes("-beta.")
        ? "beta"
        : previousTag.includes("-alpha.")
          ? "alpha"
          : "latest";
      const payload = yield* Schema.encodeEffect(Schema.fromJsonString(ReleaseNotePayload))({
        channels: [channel],
      });
      yield* runShell("seed release note", () =>
        $`git -C ${clone} notes --ref semantic-release add -f -m ${payload} ${previousTag}^{commit}`.quiet(),
      );
    }

    const clonePkgPath = path.join(clone, "apps/cli/package.json");
    const clonePkg = yield* decodePackage(clonePkgPath);
    const updatedPackage = { ...clonePkg, release: rootPkg.release ?? null };
    const encodedPackage = yield* Schema.encodeEffect(Schema.fromJsonString(PackageJsonSchema))(
      updatedPackage,
    );
    yield* fileSystem.writeFileString(clonePkgPath, `${encodedPackage}\n`);
    yield* runShell(
      "redirect repository URL",
      () => $`git -C ${clone} config --local url.file://${clone}.insteadOf ${repoUrl}`,
    );
    yield* logError(`==> Re-staged on ${branch} @ ${sha} (without tag ${tag})`);
    yield* logError("==> Running semantic-release --dry-run");

    const ignoredEnvironmentKeys = new Set([
      "GITHUB_ACTIONS",
      "GITHUB_REF",
      "GITHUB_REF_NAME",
      "GITHUB_HEAD_REF",
      "GITHUB_BASE_REF",
      "GITHUB_EVENT_NAME",
      "CI",
    ]);
    const environmentEntries = yield* collectEnvironment(
      ConfigProvider.fromEnv({ preserveEmptyStrings: true }),
    );
    const childEnv = Object.fromEntries(
      environmentEntries.filter(([key]) => !ignoredEnvironmentKeys.has(key)),
    );
    const result = yield* runForeign<SemanticReleaseResult>("semantic-release", () =>
      semanticRelease(
        { dryRun: true, noCi: true, repositoryUrl: repoUrl },
        {
          cwd: path.join(clone, "apps/cli"),
          env: childEnv,
          stdout: process.stderr,
          stderr: process.stderr,
        },
      ),
    );
    if (!result || !result.nextRelease) {
      return yield* new BackfillError({
        operation: "semantic-release",
        cause: `semantic-release did not compute a next release for ${tag}`,
      });
    }
    const expected = tag.replace(/^v/, "");
    if (result.nextRelease.version !== expected) {
      return yield* new BackfillError({
        operation: "semantic-release",
        cause: `semantic-release computed v${result.nextRelease.version} but expected ${tag}; check channel notes and release config`,
      });
    }
    const notes = result.nextRelease.notes ?? "";
    if (apply) {
      const notesFile = path.join(work, "notes.md");
      yield* fileSystem.writeFileString(notesFile, notes);
      yield* logError(`==> Updating GitHub Release body for ${tag}`);
      yield* runShell(
        "update GitHub release",
        () => $`gh release edit ${tag} --notes-file ${notesFile}`,
      );
    } else {
      yield* Effect.sync(() => {
        process.stdout.write(notes);
        if (!notes.endsWith("\n")) process.stdout.write("\n");
      });
    }
  }),
);

Effect.runPromise(Effect.scoped(main).pipe(Effect.provide(BunServices.layer))).then(
  () => {
    process.exitCode = 0;
  },
  (error: unknown) => {
    Effect.runSync(logError(errorMessage(error)));
    process.exitCode = error instanceof BackfillError ? (error.exitCode ?? 1) : 1;
  },
);
