import { Data, Effect, Ref, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

const POLL_INTERVAL = "10 seconds";
const POLL_BUDGET = "15 minutes";
const PROBE_TIMEOUT = "30 seconds";

const ABBREVIATED_PACKUMENT = "application/vnd.npm.install-v1+json";

const AbbreviatedPackument = Schema.Struct({
  versions: Schema.Record(Schema.String, Schema.Unknown),
});

export interface PackageVersion {
  readonly name: string;
  readonly version: string;
}

export class NpmRegistryRejected extends Data.TaggedError("NpmRegistryRejected")<{
  readonly message: string;
}> {}

export class NpmPackagesNotInstallable extends Data.TaggedError("NpmPackagesNotInstallable")<{
  readonly message: string;
  readonly packages: ReadonlyArray<PackageVersion>;
}> {}

const isInstallable = Effect.fnUntraced(
  function* (registryUrl: string, pkg: PackageVersion) {
    const request = HttpClientRequest.get(`${registryUrl}/${pkg.name.replaceAll("/", "%2F")}`).pipe(
      HttpClientRequest.accept(ABBREVIATED_PACKUMENT),
    );
    const res = yield* HttpClient.execute(request);

    if (res.status >= 400 && res.status < 500 && res.status !== 404) {
      return yield* new NpmRegistryRejected({
        message: `npm registry probe for ${pkg.name}@${pkg.version} returned HTTP ${res.status}`,
      });
    }
    if (res.status !== 200) return false;

    const packument = yield* HttpClientResponse.schemaBodyJson(AbbreviatedPackument)(res);
    return Object.hasOwn(packument.versions, pkg.version);
  },
  Effect.catchTag(["HttpClientError", "SchemaError"], () => Effect.succeed(false)),
  Effect.timeoutOrElse({ duration: PROBE_TIMEOUT, orElse: () => Effect.succeed(false) }),
);

/** Polls the registry until every package version is listed in its install packument. */
export const waitUntilInstallable = Effect.fnUntraced(function* (opts: {
  readonly registryUrl: string;
  readonly packages: ReadonlyArray<PackageVersion>;
  readonly onInstallable: (pkg: PackageVersion) => Effect.Effect<void>;
}) {
  const { registryUrl, packages, onInstallable } = opts;
  const pending = yield* Ref.make(packages);

  const probeRound = Effect.gen(function* () {
    const results = yield* Effect.forEach(
      yield* Ref.get(pending),
      (pkg) =>
        isInstallable(registryUrl, pkg).pipe(Effect.map((installable) => ({ pkg, installable }))),
      { concurrency: "unbounded" },
    );
    const ready = results.filter((r) => r.installable).map((r) => r.pkg);
    yield* Ref.set(
      pending,
      results.filter((r) => !r.installable).map((r) => r.pkg),
    );
    yield* Effect.forEach(ready, onInstallable, { discard: true });
  });

  yield* probeRound.pipe(
    Effect.repeat({
      schedule: Schedule.spaced(POLL_INTERVAL).pipe(Schedule.upTo({ duration: POLL_BUDGET })),
      until: () => Ref.get(pending).pipe(Effect.map((remaining) => remaining.length === 0)),
    }),
  );

  const remaining = yield* Ref.get(pending);
  if (remaining.length > 0) {
    const labels = remaining.map((pkg) => `${pkg.name}@${pkg.version}`).join(", ");
    return yield* new NpmPackagesNotInstallable({
      message:
        `Timed out after ${POLL_BUDGET} waiting for npm to make these packages installable: ${labels}. ` +
        `Re-running the publish is safe; already-published packages are skipped.`,
      packages: remaining,
    });
  }
});
