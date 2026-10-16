import type { CliConfig } from "@supabase/config/effect";
import { defaultArtifactSelection } from "@supabase/stack/defaults";
import {
  holdLock,
  isLockBusy,
  LOCK_SCHEMA_URL,
  lockSelection,
  readLock,
  writeLock,
  type Lock,
  type LockInvalidError,
  type LockIoError,
  type LockUnsupportedVersionError,
  type NamespaceError,
} from "@supabase/stack/effect";
import {
  artifactServiceKinds,
  databaseArtifactPin,
  isOrioledbVersion,
  orioledbPostgresVersion,
  postgresMajor,
  resolvePin,
  type ArtifactPin,
  type ArtifactSelection,
  type ReleaseError,
  type ServiceKind,
} from "@supabase/stack/internal/artifacts";
import {
  Clock,
  Config,
  Crypto,
  Effect,
  FileSystem,
  Option,
  Path,
  Record,
  Result,
  Schema,
} from "effect";
import { FetchHttpClient } from "effect/http";

import { ensureGitignore } from "./project-link.ts";
import { stackArtifactSelection } from "./stack-artifact-selection.ts";
import { StackConfigError } from "./stack-config.ts";
import type { Output } from "../shared/output/output.service.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";

const LOCK_FILE = "supabase/supabase.lock";
const LEASE_FILE = ".supabase.lock.lease";
const LEASE_BUDGET = "60 seconds";

type NonDatabaseKind = Exclude<ServiceKind, "database">;
type DatabaseLock = Lock["services"]["database"];
type ServiceLock = Lock["services"]["rest"];
type LocalServices = NonNullable<NonNullable<CliConfig["local"]>["services"]>;

/** The config inputs that decide which versions the lock pins. */
export interface LockRequest {
  readonly projectRoot: string;
  readonly majorVersion: number;
  readonly orioledbVersion: string | undefined;
  readonly services: LocalServices | undefined;
}

/** A parsed `[local.services]` version specifier. */
type Specifier =
  | { readonly kind: "linked" | "bundled" }
  | { readonly kind: "release"; readonly upstream: string; readonly revision?: number };

interface ServiceRequest {
  readonly specifier: string;
  readonly parsed: Specifier;
}

type ServiceRequests = Readonly<Record<ServiceKind, ServiceRequest>>;

const REVISION_SUFFIX = /^(.+)-r(0|[1-9][0-9]*)$/u;

/** Splits `linked`, `bundled`, `<U>` or `<U>-rN`; the config schema has already validated the form. */
export const parseSpecifier = (text: string): Specifier => {
  if (text === "linked" || text === "bundled") return { kind: text };
  const match = REVISION_SUFFIX.exec(text);
  const upstream = match?.[1];
  const revision = match?.[2];
  return upstream === undefined || revision === undefined
    ? { kind: "release", upstream: text }
    : { kind: "release", upstream, revision: Number(revision) };
};

/**
 * The effective specifier of every service: its own entry, else `default`, else `linked`. The
 * deprecated `[db] orioledb_version` is a `database` specifier for that OrioleDB build.
 */
const serviceRequests = (request: LockRequest): Result.Result<ServiceRequests, string> => {
  const fallback = request.services?.default?.version ?? "linked";
  const own = request.services?.database?.version;
  const alias =
    request.orioledbVersion === undefined || request.orioledbVersion.length === 0
      ? undefined
      : orioledbPostgresVersion(request.orioledbVersion);
  const parsedOwn = own === undefined ? undefined : parseSpecifier(own);
  if (
    alias !== undefined &&
    parsedOwn !== undefined &&
    !(parsedOwn.kind === "release" && parsedOwn.upstream === alias)
  )
    return Result.fail(
      `db.orioledb_version (or SUPABASE_DB_ORIOLEDB_VERSION) = ${request.orioledbVersion} conflicts with local.services.database.version = "${own}"; remove one of them`,
    );
  const database = own ?? alias ?? fallback;
  const parsedDatabase = parseSpecifier(database);
  if (
    parsedDatabase.kind === "release" &&
    postgresMajor(parsedDatabase.upstream) !== String(request.majorVersion)
  )
    return Result.fail(
      `the database version "${database}" requires db.major_version (or SUPABASE_DB_MAJOR_VERSION) = ${postgresMajor(parsedDatabase.upstream)}, but it is ${request.majorVersion}`,
    );
  return Result.succeed(
    Record.map(defaultArtifactSelection(), (_pin, kind) => {
      const specifier =
        kind === "database" ? database : (request.services?.[kind]?.version ?? fallback);
      return { specifier, parsed: parseSpecifier(specifier) };
    }),
  );
};

const pinLine = (pin: ArtifactPin) =>
  isOrioledbVersion(pin.upstreamVersion) ? "orioledb" : "stock";

/**
 * Why a locked entry no longer answers its request, or `undefined` when it still does. Only
 * resolution inputs count: the specifier, and for the database its major and line, which a
 * hand-edited pin could contradict while the specifier still matches.
 */
const staleReason = (
  kind: ServiceKind,
  entry: ServiceLock | DatabaseLock,
  request: ServiceRequest,
  majorVersion: number,
): string | undefined => {
  if (entry.specifier !== request.specifier)
    return `specifier ${request.specifier} ≠ locked ${entry.specifier}`;
  if (kind !== "database" || !("majorVersion" in entry)) return undefined;
  if (entry.majorVersion !== majorVersion)
    return `db.major_version ${majorVersion} ≠ locked ${entry.majorVersion}`;
  if (postgresMajor(entry.resolved.upstreamVersion) !== String(majorVersion))
    return `locked pin ${entry.resolved.upstreamVersion} is not Postgres ${majorVersion}`;
  const line = pinLine(entry.resolved);
  const requested =
    request.parsed.kind === "release"
      ? isOrioledbVersion(request.parsed.upstream)
        ? "orioledb"
        : "stock"
      : request.parsed.kind === "bundled"
        ? "stock"
        : line;
  return entry.line !== line || requested !== line
    ? `database line ${requested} ≠ locked ${entry.line}`
    : undefined;
};

/** The entries whose request changed since the lock was written; every entry when there is no lock. */
const staleServices = (
  lock: Lock | undefined,
  requests: ServiceRequests,
  majorVersion: number,
): ReadonlyMap<ServiceKind, string> =>
  new Map(
    artifactServiceKinds().flatMap((kind): Array<[ServiceKind, string]> => {
      const entry = lock?.services[kind];
      const reason =
        entry === undefined
          ? "not locked yet"
          : staleReason(kind, entry, requests[kind], majorVersion);
      return reason === undefined ? [] : [[kind, reason]];
    }),
  );

/** Why the project lock could not be read, resolved, or written. */
export class LockResolutionError extends Schema.TaggedError<LockResolutionError>()(
  "LockResolutionError",
  {
    reason: Schema.Literals([
      "unpublished",
      "transient",
      "integrity",
      "invalid-lock",
      "frozen-missing",
      "frozen-stale",
      "lease-busy",
      "io",
    ]),
    message: Schema.String,
  },
) {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    switch (this.reason) {
      case "unpublished":
        return { ...actionability.invalidConfig, fingerprint_suffix: "invalid_config" };
      case "transient":
        return { ...actionability.externalNetwork, fingerprint_suffix: "network" };
      case "integrity":
        return { ...actionability.externalNetwork, fingerprint_suffix: "asset_checksum" };
      case "invalid-lock":
        return { ...actionability.invalidConfig, fingerprint_suffix: "state_file" };
      case "frozen-missing":
        return { ...actionability.startStack, fingerprint_suffix: "not_found" };
      case "frozen-stale":
        return { ...actionability.startStack, fingerprint_suffix: "conflict" };
      case "lease-busy":
        return { ...actionability.invalidInput, fingerprint_suffix: "lease_held" };
      case "io":
        return { ...actionability.runtimeCrash, fingerprint_suffix: "filesystem_io" };
    }
  }
}

const lockFailure = (
  error: LockInvalidError | LockUnsupportedVersionError | LockIoError,
): LockResolutionError =>
  error._tag === "LockIoError"
    ? new LockResolutionError({ reason: "io", message: error.message })
    : new LockResolutionError({
        reason: "invalid-lock",
        message:
          error._tag === "LockInvalidError"
            ? `${error.message}; fix it, or delete it and run supabase start to resolve the versions again`
            : error.message,
      });

const RELEASE_OUTCOMES = {
  ReleaseUnpublished: { reason: "unpublished", text: "no published slim-services release" },
  ReleaseTransient: {
    reason: "transient",
    text: "the slim-services release host could not be reached; retry shortly",
  },
  ReleaseIntegrity: { reason: "integrity", text: "the published release failed verification" },
} as const;

const releaseFailure = (
  kind: ServiceKind,
  specifier: string,
  error: ReleaseError,
): LockResolutionError => {
  const outcome = RELEASE_OUTCOMES[error._tag];
  return new LockResolutionError({
    reason: outcome.reason,
    message: `local.services.${kind}.version = "${specifier}": ${outcome.text} (${error.message})`,
  });
};

const leaseFailure = (error: NamespaceError): LockResolutionError =>
  new LockResolutionError({
    reason: isLockBusy(error) ? "lease-busy" : "io",
    message: error.message,
  });

const resolvePinFor = Effect.fn("StackLock.resolvePin")(function* (
  kind: ServiceKind,
  request: ServiceRequest,
  majorVersion: number,
) {
  const { parsed, specifier } = request;
  yield* Effect.annotateCurrentSpan({
    "lock.service": kind,
    "lock.specifier_kind": parsed.kind,
  });
  if (parsed.kind === "release") {
    const pin = yield* resolvePin({
      service: kind,
      upstream: parsed.upstream,
      ...(parsed.revision === undefined ? {} : { revision: parsed.revision }),
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.mapError((error) =>
        error._tag === "ConfigError"
          ? new StackConfigError({
              message: `failed to read the slim-services endpoints: ${error.message}`,
            })
          : releaseFailure(kind, specifier, error),
      ),
      Effect.tapError((error) =>
        Effect.annotateCurrentSpan({
          "lock.outcome": error instanceof LockResolutionError ? error.reason : "config",
        }),
      ),
    );
    yield* Effect.annotateCurrentSpan({ "lock.outcome": "resolved" });
    return { pin, resolution: "resolved" } as const;
  }
  // `linked` has no hosted observation to follow yet, so it takes the bundled pin as unlinked.
  const pin =
    kind === "database"
      ? yield* databaseArtifactPin(String(majorVersion)).pipe(
          Effect.mapError((error) => new StackConfigError({ message: error.message })),
        )
      : defaultArtifactSelection()[kind];
  const resolution = parsed.kind === "bundled" ? "resolved" : "unlinked";
  yield* Effect.annotateCurrentSpan({ "lock.outcome": resolution });
  return { pin, resolution } as const;
});

const resolveService = Effect.fn("StackLock.resolveService")(function* (
  kind: NonDatabaseKind,
  request: ServiceRequest,
  majorVersion: number,
  previous: ServiceLock | undefined,
) {
  const { pin, resolution } = yield* resolvePinFor(kind, request, majorVersion);
  return {
    specifier: request.specifier,
    ...(previous?.linked === undefined ? {} : { linked: previous.linked }),
    resolution,
    resolved: pin,
  } satisfies ServiceLock;
});

const resolveDatabase = Effect.fn("StackLock.resolveDatabase")(function* (
  request: ServiceRequest,
  majorVersion: number,
  previous: DatabaseLock | undefined,
) {
  const { pin, resolution } = yield* resolvePinFor("database", request, majorVersion);
  yield* Effect.annotateCurrentSpan({ "lock.database_line": pinLine(pin) });
  return {
    specifier: request.specifier,
    ...(previous?.linked === undefined ? {} : { linked: previous.linked }),
    resolution,
    resolved: pin,
    majorVersion,
    line: pinLine(pin),
  } satisfies DatabaseLock;
});

const continuousIntegration = Config.option(Config.String("CI")).pipe(
  Effect.map((value) =>
    Option.exists(value, (text) => text !== "" && text !== "false" && text !== "0"),
  ),
  Effect.mapError(
    () => new StackConfigError({ message: "failed to resolve environment variable: CI" }),
  ),
);

/**
 * A lock that cannot be used as-is. A frozen `start` is told to commit a lock resolved elsewhere;
 * a command that only reads the lock is told to run `supabase start` here, which refreshes it.
 */
const unusableLock = (
  stale: ReadonlyMap<ServiceKind, string>,
  lock: Lock | undefined,
  audience: "frozen" | "reader",
) =>
  lock === undefined
    ? new LockResolutionError({
        reason: "frozen-missing",
        message: `${LOCK_FILE} not found; run supabase start ${audience === "frozen" ? "locally and commit it" : "to create it"}`,
      })
    : new LockResolutionError({
        reason: "frozen-stale",
        message: `${LOCK_FILE} is stale for: ${[...stale].map(([kind, reason]) => `${kind} (${reason})`).join(", ")}; ${audience === "frozen" ? "run supabase start locally and commit the updated lock" : "run supabase start to refresh it"}`,
      });

const version = (pin: ArtifactPin) => `${pin.upstreamVersion}-r${pin.revision}`;

const diffLines = (
  previous: Lock | undefined,
  lock: Lock,
  stale: ReadonlyMap<ServiceKind, string>,
) =>
  [...stale].map(([kind, reason]) => {
    const entry = lock.services[kind];
    const before = previous?.services[kind];
    const arrow = before === undefined ? "" : `${version(before.resolved)} → `;
    const why = before === undefined ? `specifier ${entry.specifier}` : reason;
    const detail = entry.resolution === "resolved" ? why : `${why}; ${entry.resolution}`;
    return `  ${kind.padEnd(9)} ${arrow}${version(entry.resolved)}  (${detail})`;
  });

const requestsOf = (request: LockRequest) =>
  Effect.fromResult(serviceRequests(request)).pipe(
    Effect.mapError((message) => new StackConfigError({ message })),
  );

const inspectLock = Effect.fn("StackLock.inspect")(function* (
  request: LockRequest,
  requests: ServiceRequests,
) {
  const previous = Option.getOrUndefined(
    yield* readLock(request.projectRoot).pipe(Effect.mapError(lockFailure)),
  );
  return { previous, stale: staleServices(previous, requests, request.majorVersion) };
});

/** The pins of a fresh lock, without the lease or any resolution; a missing or stale lock fails. */
export const readLockedSelection = Effect.fn("StackLock.read")(function* (request: LockRequest) {
  const { previous, stale } = yield* inspectLock(request, yield* requestsOf(request));
  if (previous === undefined || stale.size > 0)
    return yield* unusableLock(stale, previous, "reader");
  return lockSelection(previous);
});

/**
 * The pins of a fresh lock, or the bundled ones when the project has no lock yet. Commands that
 * never resolve use this to run the versions `start` locked; a stale lock still fails.
 */
export const readSelectionOrBundled = Effect.fn("StackLock.readOrBundled")(function* (
  request: LockRequest,
) {
  const previous = Option.getOrUndefined(
    yield* readLock(request.projectRoot).pipe(Effect.mapError(lockFailure)),
  );
  if (previous === undefined) {
    yield* Effect.annotateCurrentSpan({ "lock.found": false });
    return yield* stackArtifactSelection({
      major_version: request.majorVersion,
      orioledb_version: request.orioledbVersion,
    }).pipe(Effect.mapError((error) => new StackConfigError({ message: error.message })));
  }
  const stale = staleServices(previous, yield* requestsOf(request), request.majorVersion);
  yield* Effect.annotateCurrentSpan({ "lock.found": true, "lock.stale_count": stale.size });
  if (stale.size > 0) return yield* unusableLock(stale, previous, "reader");
  return lockSelection(previous);
});

const holdLease = Effect.fn("StackLock.lease")(function* (projectRoot: string) {
  const path = yield* Path.Path;
  const started = yield* Clock.currentTimeMillis;
  yield* holdLock(path.join(projectRoot, "supabase", LEASE_FILE), LEASE_BUDGET, LOCK_FILE).pipe(
    Effect.mapError(leaseFailure),
  );
  yield* Effect.annotateCurrentSpan({
    "lock.lease_wait_ms": (yield* Clock.currentTimeMillis) - started,
  });
});

/**
 * Fails a project without `supabase/config.toml` that is frozen, explicitly or by `CI` with a
 * lock present: with no config the lock cannot be checked, so the bundled versions must not
 * silently stand in for it.
 */
export const rejectFrozenWithoutConfig = Effect.fn("StackLock.rejectFrozenWithoutConfig")(
  function* (projectRoot: string, frozen: boolean) {
    if (frozen)
      return yield* new LockResolutionError({
        reason: "frozen-missing",
        message: `${LOCK_FILE} not found; run supabase start locally and commit it`,
      });
    if (!(yield* continuousIntegration)) return;
    const lock = yield* readLock(projectRoot).pipe(Effect.mapError(lockFailure));
    if (Option.isSome(lock))
      return yield* new LockResolutionError({
        reason: "frozen-missing",
        message: `supabase/config.toml not found, so ${LOCK_FILE} cannot be checked in CI; commit supabase/config.toml next to it`,
      });
  },
);

/**
 * Selects the pins a stack command runs from `supabase/supabase.lock`, under the project lease:
 * a fresh lock is used as-is; a missing or stale one is resolved and rewritten, unless frozen.
 * Frozen is explicit, or implied when `CI` is set and a lock exists.
 */
export const lockedSelection = (options: {
  readonly frozen: boolean;
  readonly output: Output["Service"];
}) =>
  Effect.fn("StackLock.select")(function* (
    request: LockRequest,
  ): Effect.fn.Return<
    ArtifactSelection,
    StackConfigError | LockResolutionError,
    FileSystem.FileSystem | Path.Path | Crypto.Crypto
  > {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const requests = yield* requestsOf(request);
    const ci = yield* continuousIntegration;

    return yield* Effect.gen(function* () {
      yield* holdLease(request.projectRoot);
      const { previous, stale } = yield* inspectLock(request, requests);
      const frozen = options.frozen || (ci && previous !== undefined);
      yield* Effect.annotateCurrentSpan({
        "lock.found": previous !== undefined,
        "lock.frozen": frozen,
        "lock.stale_count": stale.size,
      });
      if (previous !== undefined && stale.size === 0) return lockSelection(previous);
      if (frozen) return yield* unusableLock(stale, previous, "frozen");

      const settle = <A, E, R>(
        kind: ServiceKind,
        current: A | undefined,
        resolve: () => Effect.Effect<A, E, R>,
      ) => (current === undefined || stale.has(kind) ? resolve() : Effect.succeed(current));
      const service = (kind: NonDatabaseKind) =>
        settle(kind, previous?.services[kind], () =>
          resolveService(kind, requests[kind], request.majorVersion, previous?.services[kind]),
        );
      const services = yield* Effect.all(
        {
          database: settle("database", previous?.services.database, () =>
            resolveDatabase(requests.database, request.majorVersion, previous?.services.database),
          ),
          rest: service("rest"),
          auth: service("auth"),
          realtime: service("realtime"),
          storage: service("storage"),
          imgproxy: service("imgproxy"),
          functions: service("functions"),
          studio: service("studio"),
          pgmeta: service("pgmeta"),
          mail: service("mail"),
          analytics: service("analytics"),
          pooler: service("pooler"),
        },
        { concurrency: 4 },
      );
      const lock: Lock = {
        $schema: LOCK_SCHEMA_URL,
        lockfileVersion: 1,
        ...(previous?.linked === undefined ? {} : { linked: previous.linked }),
        services,
      };
      yield* ensureGitignore(fs, path, request.projectRoot).pipe(
        Effect.mapError(
          (error) =>
            new LockResolutionError({
              reason: "io",
              message: `failed to update supabase/.gitignore: ${error.message}`,
            }),
        ),
      );
      yield* writeLock(request.projectRoot, lock).pipe(Effect.mapError(lockFailure));
      yield* options.output.info(
        [
          "Resolved service versions:",
          ...diffLines(previous, lock, stale),
          `${previous === undefined ? "Created" : "Updated"} ${LOCK_FILE}.`,
        ].join("\n"),
      );
      if (previous === undefined && ci)
        yield* options.output.warn(
          `Commit ${LOCK_FILE} so CI and your team run the same versions.`,
        );
      return lockSelection(lock);
    }).pipe(Effect.scoped);
  });
