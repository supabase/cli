import { $ } from "bun";
import process from "node:process";
import { parseArgs } from "node:util";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Console, Data, Effect, Fiber, FileSystem, Layer, Path, Predicate } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { waitUntilInstallable } from "./npm-registry.ts";
import { isPublishableNpmTag, PUBLISHABLE_NPM_TAGS_HINT } from "./release-channels.ts";

const PLATFORM_PACKAGES = [
  "cli-darwin-arm64",
  "cli-darwin-x64",
  "cli-linux-arm64",
  "cli-linux-arm64-musl",
  "cli-linux-x64",
  "cli-linux-x64-musl",
  "cli-windows-arm64",
  "cli-windows-x64",
];

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    tag: { type: "string", default: "latest" },
  },
});

const dryRun = values["dry-run"];
const tag = values.tag;

const dryRunFlag = dryRun ? ["--dry-run"] : [];
const tagFlag = ["--tag", tag];
const provenanceFlag = ["--provenance"];
const noGitChecksFlag = ["--no-git-checks"];

class PublishStepFailed extends Data.TaggedError("PublishStepFailed")<{
  readonly cause: unknown;
}> {}

class RegistryProbeFailed extends Data.TaggedError("RegistryProbeFailed")<{
  readonly message: string;
}> {}

const step = <A>(run: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new PublishStepFailed({ cause }) });

// Used as both a pre-flight skip check and post-failure reconciliation, since a publish can
// fail with E403 when the registry CDN cache lags behind an already-succeeded publish.
const isAlreadyPublished = Effect.fnUntraced(function* (
  registryUrl: string,
  name: string,
  version: string,
) {
  const encodedName = name.replace("/", "%2F");
  const res = yield* HttpClient.get(`${registryUrl}/${encodedName}/${version}`);
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  return yield* new RegistryProbeFailed({
    message: `npm registry probe for ${name}@${version} returned HTTP ${res.status}`,
  });
});

type PublishResult = "published" | "skipped";

// Skips a version already on the registry — checked before publishing and again after a
// publish-time conflict — and lets any other failure propagate.
const publishPackage = Effect.fnUntraced(function* (opts: {
  registryUrl: string;
  name: string;
  version: string;
  cwd: string;
  extraFlags?: string[];
}) {
  const { registryUrl, name, version, cwd, extraFlags = [] } = opts;
  const label = `${name}@${version}`;

  if (yield* isAlreadyPublished(registryUrl, name, version)) {
    yield* Console.log(`  [skip] ${label} already published.`);
    return "skipped" satisfies PublishResult;
  }

  yield* Console.log(`  Publishing ${label}...`);
  return yield* step(() =>
    $`pnpm publish ${extraFlags} ${provenanceFlag} ${tagFlag} ${noGitChecksFlag} ${dryRunFlag}`.cwd(
      cwd,
    ),
  ).pipe(
    Effect.andThen(Console.log(`  ${label} published.`)),
    Effect.as<PublishResult>("published"),
    Effect.catchTag("PublishStepFailed", (error) =>
      Effect.gen(function* () {
        if (yield* isAlreadyPublished(registryUrl, name, version)) {
          yield* Console.log(
            `  [skip] ${label} reported a conflict but is now present on the registry; treating as success.`,
          );
          return "skipped" satisfies PublishResult;
        }
        return yield* error;
      }),
    ),
  );
});

const main = Effect.gen(function* () {
  if (!isPublishableNpmTag(tag)) {
    yield* Console.error(
      `Invalid --tag value: ${String(tag)}. Expected one of: ${PUBLISHABLE_NPM_TAGS_HINT}.`,
    );
    return yield* Effect.sync(() => process.exit(1));
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(import.meta.dir, "../../..");
  const cliDir = path.join(root, "apps/cli");
  const cliPkgJson = yield* step(() => Bun.file(path.join(cliDir, "package.json")).json());
  const umbrellaName: string = cliPkgJson.name;
  const umbrellaVersion: string = cliPkgJson.version;

  // Uses `npm config get registry` instead of hard-coding registry.npmjs.org, so the probe and
  // publish target agree — needed for the local Verdaccio harness (`pnpm local-registry`).
  const registryUrl = (yield* step(() => $`npm config get registry`.quiet().text()))
    .trim()
    .replace(/\/$/, "");

  yield* Console.log(
    dryRun
      ? `Publishing to npm with tag "${tag}" (dry run)...\n`
      : `Publishing to npm with tag "${tag}"...\n`,
  );

  // Every platform package must already be at the umbrella version; `sync-versions.ts` runs
  // before this in the release workflow, so a mismatch means the script ran out of order.
  for (const pkg of PLATFORM_PACKAGES) {
    const pkgJson = yield* step(() =>
      Bun.file(path.join(root, "packages", pkg, "package.json")).json(),
    );
    if (pkgJson.version !== umbrellaVersion) {
      yield* Console.error(
        `Version mismatch: @supabase/${pkg} is ${pkgJson.version}, expected ${umbrellaVersion}. Run sync-versions.ts first.`,
      );
      return yield* Effect.sync(() => process.exit(1));
    }
  }

  yield* Console.log("Publishing platform packages...");
  /* Detached so a failed job fails the run without cancelling its siblings; callers observe
     completion with Fiber.joinAll. */
  const platformResults = yield* Fiber.joinAll(
    yield* Effect.forEach(PLATFORM_PACKAGES, (pkg) =>
      publishPackage({
        registryUrl,
        name: `@supabase/${pkg}`,
        version: umbrellaVersion,
        cwd: path.join(root, "packages", pkg),
        extraFlags: ["--access", "public"],
      }).pipe(Effect.forkDetach({ startImmediately: true })),
    ),
  );

  // npm makes large tarballs installable minutes after the PUT returns, so the umbrella must wait
  // for its binaries or installs in that window get no binary.
  if (!dryRun) {
    yield* Console.log("\nWaiting for platform packages to become installable...");
    yield* waitUntilInstallable({
      registryUrl,
      packages: PLATFORM_PACKAGES.map((pkg) => ({
        name: `@supabase/${pkg}`,
        version: umbrellaVersion,
      })),
      onInstallable: ({ name, version }) => Console.log(`  ${name}@${version} is installable.`),
    });
  }

  yield* Console.log("\nBuilding umbrella package shim...");
  yield* step(() => $`pnpm build:shim`.cwd(cliDir));

  // npm renders the README from the package directory; apps/cli/README.md documents the source
  // layout for contributors, not what npm users should see, so copy the root README over it.
  yield* Console.log("\nStaging root README for umbrella package...");
  yield* fs.copyFile(path.join(root, "README.md"), path.join(cliDir, "README.md"));

  yield* Console.log(`Publishing umbrella package ${umbrellaName}...`);
  const umbrellaResult = yield* publishPackage({
    registryUrl,
    name: umbrellaName,
    version: umbrellaVersion,
    cwd: cliDir,
  });

  const results = [...platformResults, umbrellaResult];
  const publishedCount = results.filter((r) => r === "published").length;
  const skippedCount = results.filter((r) => r === "skipped").length;

  yield* Console.log(`\nPublished: ${publishedCount}, Skipped: ${skippedCount}.`);

  // All-skipped is ambiguous: it may mean a downstream-only retry (bytes already on npm) or that
  // today's commits silently didn't ship a new version. Warn loudly so a human can decide whether
  // to re-cut via workflow_dispatch.
  if (publishedCount === 0) {
    yield* Console.warn(
      `\n[warn] No packages were published — every package was already on the registry at ${umbrellaVersion}.\n` +
        `       If today's commits were expected to ship, the version did not advance.\n` +
        `       Re-cut as a fresh version via the Release workflow (workflow_dispatch).`,
    );
  }

  yield* Console.log("\nAll packages published successfully.");
});

/* A registry URL that cannot be parsed fails as `fetch` reports an invalid URL. */
function thrownValue(error: { readonly message: string; readonly cause?: unknown }): unknown {
  if (
    Predicate.isTagged(error, "HttpClientError") &&
    Predicate.hasProperty(error, "reason") &&
    Predicate.isTagged(error.reason, "InvalidUrlError")
  ) {
    return Object.assign(new TypeError("fetch() URL is invalid"), { code: "ERR_INVALID_URL" });
  }
  return error.cause !== undefined ? error.cause : new Error(error.message);
}

await Effect.runPromise(
  main.pipe(
    Effect.catch((error) => Effect.die(thrownValue(error))),
    Effect.provide(
      Layer.mergeAll(
        BunFileSystem.layer,
        BunPath.layer,
        FetchHttpClient.layer,
        Layer.succeed(HttpClient.TracerPropagationEnabled, false),
      ),
    ),
  ),
);
