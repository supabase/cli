import { Data, Effect, Ref, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

const POLL_INTERVAL = "10 seconds";
const POLL_BUDGET = "15 minutes";
const PROBE_TIMEOUT = "30 seconds";
const RETRYABLE_CLIENT_STATUSES = new Set([404, 408, 429]);

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

type Probe =
  | { readonly installable: true }
  | { readonly installable: false; readonly reason: string };

interface Pending {
  readonly pkg: PackageVersion;
  readonly reason: string;
}

const installable: Probe = { installable: true };
const notYet = (reason: string): Probe => ({ installable: false, reason });

const probe = Effect.fnUntraced(
  function* (registryUrl: string, pkg: PackageVersion) {
    const request = HttpClientRequest.get(`${registryUrl}/${pkg.name.replaceAll("/", "%2F")}`).pipe(
      HttpClientRequest.accept(ABBREVIATED_PACKUMENT),
    );
    const res = yield* HttpClient.execute(request);

    if (res.status >= 400 && res.status < 500 && !RETRYABLE_CLIENT_STATUSES.has(res.status)) {
      return yield* new NpmRegistryRejected({
        message: `npm registry probe for ${pkg.name}@${pkg.version} returned HTTP ${res.status}`,
      });
    }
    if (res.status !== 200) return notYet(`HTTP ${res.status}`);

    const packument = yield* HttpClientResponse.schemaBodyJson(AbbreviatedPackument)(res);
    return Object.hasOwn(packument.versions, pkg.version)
      ? installable
      : notYet(`${pkg.version} not listed yet`);
  },
  Effect.catchTags({
    HttpClientError: (error) => Effect.succeed(notYet(error.message)),
    SchemaError: () => Effect.succeed(notYet("unreadable packument")),
  }),
  Effect.timeoutOrElse({
    duration: PROBE_TIMEOUT,
    orElse: () => Effect.succeed(notYet(`no response within ${PROBE_TIMEOUT}`)),
  }),
);

/** Polls the registry until every package version is listed in its install packument. */
export const waitUntilInstallable = Effect.fn("NpmRegistry.waitUntilInstallable")(function* (opts: {
  readonly registryUrl: string;
  readonly packages: ReadonlyArray<PackageVersion>;
  readonly onInstallable: (pkg: PackageVersion) => Effect.Effect<void>;
}) {
  const { registryUrl, packages, onInstallable } = opts;
  const pending = yield* Ref.make<ReadonlyArray<Pending>>(
    packages.map((pkg) => ({ pkg, reason: "not probed" })),
  );
  const attempts = yield* Ref.make(0);

  const probeRound = Effect.gen(function* () {
    yield* Ref.update(attempts, (count) => count + 1);
    const results = yield* Effect.forEach(
      yield* Ref.get(pending),
      ({ pkg }) => probe(registryUrl, pkg).pipe(Effect.map((result) => ({ pkg, result }))),
      { concurrency: "unbounded" },
    );
    yield* Ref.set(
      pending,
      results.flatMap(({ pkg, result }) =>
        result.installable ? [] : [{ pkg, reason: result.reason }],
      ),
    );
    yield* Effect.forEach(
      results.filter(({ result }) => result.installable),
      ({ pkg }) => onInstallable(pkg),
      { discard: true },
    );
  }).pipe(Effect.withTracerEnabled(false));

  yield* probeRound.pipe(
    Effect.repeat({
      schedule: Schedule.spaced(POLL_INTERVAL).pipe(Schedule.upTo({ duration: POLL_BUDGET })),
      until: () => Ref.get(pending).pipe(Effect.map((remaining) => remaining.length === 0)),
    }),
    Effect.ensuring(
      Effect.all([Ref.get(attempts), Ref.get(pending)]).pipe(
        Effect.flatMap(([count, remaining]) =>
          Effect.annotateCurrentSpan({
            "retry.attempt_count": count,
            "npm.package_count": packages.length,
            "npm.pending_count": remaining.length,
          }),
        ),
      ),
    ),
  );

  const remaining = yield* Ref.get(pending);
  if (remaining.length > 0) {
    const labels = remaining
      .map(({ pkg, reason }) => `${pkg.name}@${pkg.version} (last probe: ${reason})`)
      .join(", ");
    return yield* new NpmPackagesNotInstallable({
      message:
        `Timed out after ${POLL_BUDGET} waiting for npm to make these packages installable: ${labels}. ` +
        `Re-running the publish is safe; already-published packages are skipped.`,
      packages: remaining.map(({ pkg }) => pkg),
    });
  }
});
