import { $ } from "bun";
import process from "node:process";
import { parseArgs } from "node:util";
import { BunServices } from "@effect/platform-bun";
import { Data, Effect, FileSystem, Layer, Schema } from "effect";
import * as EffectPath from "effect/Path";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

class PublishError extends Data.TaggedError("PublishError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

const errorMessage = (error: unknown) =>
  error instanceof PublishError
    ? `${error.operation}: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`
    : error instanceof Error
      ? error.message
      : String(error);
const writeStderr = (message: string) =>
  Effect.sync(() => {
    process.stderr.write(`${message}\n`);
  });

const PLATFORM_PACKAGES = [
  "cli-darwin-arm64",
  "cli-darwin-x64",
  "cli-linux-arm64",
  "cli-linux-arm64-musl",
  "cli-linux-x64",
  "cli-linux-x64-musl",
  "cli-windows-arm64",
  "cli-windows-x64",
] as const;

const VALID_TAGS = new Set(["latest", "alpha", "beta"]);
const PackageJson = Schema.Struct({ name: Schema.String, version: Schema.String });

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    tag: { type: "string", default: "latest" },
  },
});

const dryRun = values["dry-run"] === true;
const tag = values.tag ?? "latest";

const runShell = <A>(operation: string, command: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: command,
    catch: (cause) => new PublishError({ operation, cause }),
  });

type PublishResult = "published" | "skipped";

const main = Effect.gen(function* () {
  const path = yield* EffectPath.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const client = yield* HttpClient.HttpClient;
  const root = path.resolve(import.meta.dir, "../../..");
  const cliDir = path.join(root, "apps/cli");
  const dryRunFlag = dryRun ? ["--dry-run"] : [];
  const tagFlag = ["--tag", tag];
  const provenanceFlag = ["--provenance"];
  const noGitChecksFlag = ["--no-git-checks"];

  const log = (message: string) =>
    Effect.sync(() => {
      process.stdout.write(`${message}\n`);
    });
  const logError = (message: string) => writeStderr(message);

  const readPackageJson = (filePath: string) =>
    fileSystem.readFileString(filePath, "utf8").pipe(
      Effect.flatMap((contents) =>
        Schema.decodeEffect(Schema.fromJsonString(PackageJson))(contents),
      ),
      Effect.mapError((cause) => new PublishError({ operation: `read ${filePath}`, cause })),
    );

  const isAlreadyPublished = (name: string, version: string) => {
    const encodedName = name.replace("/", "%2F");
    const url = `${registryUrl}/${encodedName}/${version}`;
    return client.execute(HttpClientRequest.get(url)).pipe(
      Effect.flatMap((response) => {
        if (response.status === 200) return Effect.succeed(true);
        if (response.status === 404) return Effect.succeed(false);
        return Effect.fail(
          new PublishError({
            operation: `probe ${name}@${version}`,
            cause: `HTTP ${response.status}`,
          }),
        );
      }),
      Effect.mapError((cause) =>
        cause instanceof PublishError
          ? cause
          : new PublishError({ operation: `probe ${name}@${version}`, cause }),
      ),
    );
  };

  const publishPackage = (opts: {
    readonly name: string;
    readonly version: string;
    readonly cwd: string;
    readonly extraFlags?: ReadonlyArray<string>;
  }): Effect.Effect<PublishResult, PublishError> => {
    const { name, version, cwd, extraFlags = [] } = opts;
    const label = `${name}@${version}`;
    return Effect.gen(function* () {
      if (yield* isAlreadyPublished(name, version)) {
        yield* log(`  [skip] ${label} already published.`);
        return "skipped" satisfies PublishResult;
      }

      yield* log(`  Publishing ${label}...`);
      return yield* runShell(`publish ${label}`, () =>
        $`pnpm publish ${extraFlags} ${provenanceFlag} ${tagFlag} ${noGitChecksFlag} ${dryRunFlag}`.cwd(
          cwd,
        ),
      ).pipe(
        Effect.as<PublishResult>("published"),
        Effect.catch((error) =>
          isAlreadyPublished(name, version).pipe(
            Effect.flatMap((alreadyPublished) =>
              alreadyPublished
                ? log(
                    `  [skip] ${label} reported a conflict but is now present on the registry; treating as success.`,
                  ).pipe(Effect.as<PublishResult>("skipped"))
                : Effect.fail(error),
            ),
          ),
        ),
      );
    });
  };

  const registryUrl = (yield* runShell("npm registry lookup", () =>
    $`npm config get registry`.quiet().text(),
  ))
    .trim()
    .replace(/\/$/, "");
  const cliPackage = yield* readPackageJson(path.join(cliDir, "package.json"));

  yield* log(
    dryRun
      ? `Publishing to npm with tag "${tag}" (dry run)...\n`
      : `Publishing to npm with tag "${tag}"...\n`,
  );

  const platformPackages = yield* Effect.forEach(PLATFORM_PACKAGES, (pkg) =>
    readPackageJson(path.join(root, "packages", pkg, "package.json")).pipe(
      Effect.flatMap((pkgJson) =>
        pkgJson.version === cliPackage.version
          ? Effect.succeed({ pkg, pkgJson })
          : Effect.fail(
              new PublishError({
                operation: `validate ${pkg}`,
                cause: `Version mismatch: @supabase/${pkg} is ${pkgJson.version}, expected ${cliPackage.version}. Run sync-versions.ts first.`,
              }),
            ),
      ),
    ),
  );

  yield* log("Publishing platform packages...");
  const platformResults = yield* Effect.forEach(
    platformPackages,
    ({ pkg }) =>
      publishPackage({
        name: `@supabase/${pkg}`,
        version: cliPackage.version,
        cwd: path.join(root, "packages", pkg),
        extraFlags: ["--access", "public"],
      }),
    { concurrency: "unbounded" },
  );

  yield* log("\nBuilding umbrella package shim...");
  yield* runShell("build umbrella shim", () => $`pnpm build:shim`.cwd(cliDir));
  yield* log("\nStaging root README for umbrella package...");
  yield* fileSystem.copyFile(path.join(root, "README.md"), path.join(cliDir, "README.md"));
  yield* log(`Publishing umbrella package ${cliPackage.name}...`);
  const umbrellaResult = yield* publishPackage({
    name: cliPackage.name,
    version: cliPackage.version,
    cwd: cliDir,
  });

  const results = [...platformResults, umbrellaResult];
  const publishedCount = results.filter((result) => result === "published").length;
  const skippedCount = results.filter((result) => result === "skipped").length;
  yield* log(`\nPublished: ${publishedCount}, Skipped: ${skippedCount}.`);
  if (publishedCount === 0) {
    yield* logError(
      `\n[warn] No packages were published — every package was already on the registry at ${cliPackage.version}.\n` +
        "       If today's commits were expected to ship, the version did not advance.\n" +
        "       Re-cut as a fresh version via the Release workflow (workflow_dispatch).",
    );
  }
  yield* log("\nAll packages published successfully.");
  return 0;
});

const checkedMain =
  tag && VALID_TAGS.has(tag)
    ? main
    : Effect.fail(
        new PublishError({
          operation: "validate --tag",
          cause: `Invalid --tag value: ${String(tag)}. Expected one of: ${[...VALID_TAGS].join(", ")}.`,
        }),
      );

Effect.runPromise(
  checkedMain.pipe(Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer))),
).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    Effect.runSync(writeStderr(errorMessage(error)));
    process.exitCode = 1;
  },
);
