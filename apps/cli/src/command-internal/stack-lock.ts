import type { CliConfig } from "@supabase/config/effect";
import { defaultArtifactSelection } from "@supabase/stack/defaults";
import {
  holdLock,
  isLockBusy,
  Lock,
  LOCK_SCHEMA_URL,
  lockSelection,
  readLock,
  writeLock,
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
  DateTime,
  Effect,
  FileSystem,
  Option,
  Path,
  Record,
  Result,
  Schema,
} from "effect";
import { FetchHttpClient } from "effect/http";

import { ensureGitignore, readProjectLink } from "./project-link.ts";
import { stackArtifactSelection } from "./stack-artifact-selection.ts";
import { StackConfigError } from "./stack-config.ts";
import type { HostedObservation } from "./tenant-versions.ts";
import type { Output } from "../shared/output/output.service.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";

/** The project lock, relative to the project root. */
export const LOCK_FILE = "supabase/supabase.lock";
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

/** The pin compiled into this CLI for a service; the database's depends on the Postgres major. */
const bundledPin = (kind: ServiceKind, majorVersion: number) =>
  kind === "database"
    ? databaseArtifactPin(String(majorVersion)).pipe(
        Effect.mapError((error) => new StackConfigError({ message: error.message })),
      )
    : Effect.succeed(defaultArtifactSelection()[kind]);

type LinkedVersion = NonNullable<ServiceLock["linked"]>;
type LinkedRemote = NonNullable<Lock["linked"]>;

const OBSERVABLE_KINDS = ["database", "rest", "auth", "storage"] as const;

/** The services whose version the platform reports; a probe observes these and no others. */
type ObservableKind = (typeof OBSERVABLE_KINDS)[number];

const isObservable = (kind: ServiceKind): kind is ObservableKind =>
  OBSERVABLE_KINDS.some((observable) => observable === kind);

/** What a hosted probe learned: its remote, and what the platform reported for each observable service. */
export interface HostedProbe {
  readonly remote: Pick<LinkedRemote, "project" | "branch">;
  readonly observations: Readonly<Record<ObservableKind, HostedObservation>>;
}

const probedObservation = (probe: HostedProbe, kind: ServiceKind): HostedObservation | undefined =>
  isObservable(kind) ? probe.observations[kind] : undefined;

/** Where `linked` specifiers take the hosted versions they follow from. */
interface LinkedSource {
  /** The remote the observations belong to; absent when the project was never linked. */
  readonly remote: LinkedRemote | undefined;
  /** Whether the previous lock observed this same remote, so its entries may be kept. */
  readonly sameRemote: boolean;
  readonly observation: (kind: ServiceKind) => HostedObservation;
  /** Whether the observations come from a fresh probe; entries that do not follow `linked` then take them too. */
  readonly probed: boolean;
  /** `stack update` moves fallback pins to this CLI's; `link` and `start` keep a fallback that has not changed. */
  readonly refresh: boolean;
}

const UNREPORTED: HostedObservation = { _tag: "Unreported" };

/** The observations the previous lock stored for its own remote, without probing. */
const storedSource = (previous: Lock | undefined, refresh: boolean): LinkedSource => ({
  remote: previous?.linked,
  sameRemote: true,
  observation: (kind) => {
    const stored = previous?.services[kind].linked;
    return stored === undefined ? UNREPORTED : { _tag: "Observed", ...stored };
  },
  probed: false,
  refresh,
});

const probedSource = (
  previous: Lock | undefined,
  probe: HostedProbe,
  observedAt: string,
  refresh: boolean,
): LinkedSource => ({
  remote: { ...probe.remote, observedAt },
  sameRemote:
    previous?.linked !== undefined &&
    previous.linked.project === probe.remote.project &&
    previous.linked.branch.ref === probe.remote.branch.ref,
  observation: (kind) => probedObservation(probe, kind) ?? UNREPORTED,
  probed: true,
  refresh,
});

const observedVersion = (observed: HostedObservation): LinkedVersion | undefined =>
  observed._tag === "Observed" ? { raw: observed.raw, version: observed.version } : undefined;

/** The hosted version to record on an entry; a failed probe keeps the previous one only for the same remote. */
const linkedObservation = (
  kind: ServiceKind,
  previous: ServiceLock | DatabaseLock | undefined,
  source: LinkedSource,
): LinkedVersion | undefined => {
  const observed = source.observation(kind);
  return observed._tag === "Failed"
    ? source.sameRemote
      ? previous?.linked
      : undefined
    : observedVersion(observed);
};

interface ResolvedPin {
  readonly pin: ArtifactPin;
  readonly resolution: ServiceLock["resolution"];
  readonly linked: LinkedVersion | undefined;
  /** A fallback or kept entry the user should hear about. */
  readonly notice: string | undefined;
  /** Whether the previous entry was kept rather than resolved again. */
  readonly kept: boolean;
  /** The release host outage this result stands in for; the pin is what the entry falls back to. */
  readonly outage?: LockResolutionError;
}

const releasePin = (kind: ServiceKind, upstream: string, revision: number | undefined) =>
  resolvePin({
    service: kind,
    upstream,
    ...(revision === undefined ? {} : { revision }),
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.mapError((error) =>
      error._tag === "ConfigError"
        ? new StackConfigError({
            message: `failed to read the slim-services endpoints: ${error.message}`,
          })
        : error,
    ),
  );

/**
 * Resolves a `linked` request from the hosted observation. Without a remote or an observable
 * version it takes the bundled pin; a transient failure keeps the previous entry only when the
 * remote and every resolution input are unchanged.
 */
const resolveLinked = Effect.fn("StackLock.resolveLinked")(function* (
  kind: ServiceKind,
  request: ServiceRequest,
  majorVersion: number,
  previous: ServiceLock | DatabaseLock | undefined,
  source: LinkedSource,
) {
  const observed = source.observation(kind);
  const linked = linkedObservation(kind, previous, source);
  const bundled = yield* bundledPin(kind, majorVersion);
  const safe =
    source.sameRemote &&
    previous !== undefined &&
    staleReason(kind, previous, request, majorVersion) === undefined
      ? previous
      : undefined;
  const keep = (entry: ServiceLock | DatabaseLock, notice: string | undefined): ResolvedPin => ({
    pin: entry.resolved,
    resolution: entry.resolution,
    linked: entry.linked,
    notice,
    kept: true,
  });
  const fallback = (
    resolution: "unlinked" | "unobserved" | "unpublished",
    notice: string | undefined,
    unchanged: boolean,
  ): ResolvedPin =>
    safe !== undefined && unchanged && !source.refresh && safe.resolution === resolution
      ? keep(safe, notice)
      : { pin: bundled, resolution, linked, notice, kept: false };
  const retained = (cause: string, outage?: LockResolutionError): ResolvedPin => {
    const fallen: ResolvedPin =
      safe === undefined
        ? {
            pin: bundled,
            resolution: "unobserved",
            linked,
            notice: `${kind}: ${cause}; using the bundled ${version(bundled)}. supabase link or supabase stack update retries.`,
            kept: false,
          }
        : keep(safe, `${kind}: ${cause}; kept ${version(safe.resolved)}`);
    return outage === undefined ? fallen : { ...fallen, outage };
  };

  if (source.remote === undefined) return fallback("unlinked", undefined, true);
  if (observed._tag === "Unreported")
    return fallback(
      "unobserved",
      isObservable(kind)
        ? `${kind}: the platform does not report its version; using the bundled ${version(bundled)}`
        : undefined,
      true,
    );
  if (observed._tag === "Failed")
    return retained(`the hosted version could not be read (${observed.cause})`);

  const sameObservation = safe?.linked?.version === observed.version;
  if (kind === "database" && postgresMajor(observed.version) !== String(majorVersion))
    return fallback(
      "unpublished",
      `database: hosted Postgres ${observed.raw} does not match db.major_version ${majorVersion}; using the bundled ${version(bundled)}`,
      sameObservation,
    );
  return yield* releasePin(kind, observed.version, undefined).pipe(
    Effect.map((pin): ResolvedPin => ({
      pin,
      resolution: "resolved",
      linked,
      notice: undefined,
      kept: false,
    })),
    Effect.catchTags({
      ReleaseUnpublished: () =>
        Effect.succeed(
          fallback(
            "unpublished",
            `${kind}: hosted ${observed.raw} is not published by slim-services; using the bundled ${version(bundled)}`,
            sameObservation,
          ),
        ),
      ReleaseTransient: (error) =>
        Effect.succeed(
          retained(
            "the slim-services release host could not be reached",
            releaseFailure(kind, request.specifier, error),
          ),
        ),
      ReleaseIntegrity: (error) => Effect.fail(releaseFailure(kind, request.specifier, error)),
    }),
  );
});

const resolvePinFor = Effect.fn("StackLock.resolvePin")(function* (
  kind: ServiceKind,
  request: ServiceRequest,
  majorVersion: number,
  previous: ServiceLock | DatabaseLock | undefined,
  source: LinkedSource,
) {
  const { parsed, specifier } = request;
  yield* Effect.annotateCurrentSpan({
    "lock.service": kind,
    "lock.specifier_kind": parsed.kind,
  });
  const resolved: ResolvedPin =
    parsed.kind === "linked"
      ? yield* resolveLinked(kind, request, majorVersion, previous, source)
      : {
          pin:
            parsed.kind !== "release"
              ? yield* bundledPin(kind, majorVersion)
              : yield* releasePin(kind, parsed.upstream, parsed.revision).pipe(
                  Effect.mapError((error) =>
                    error._tag === "StackConfigError"
                      ? error
                      : releaseFailure(kind, specifier, error),
                  ),
                ),
          resolution: "resolved",
          linked: linkedObservation(kind, previous, source),
          notice: undefined,
          kept: false,
        };
  yield* Effect.annotateCurrentSpan({
    "lock.outcome": resolved.resolution,
    "lock.kept": resolved.kept,
  });
  return resolved;
});

/** A resolved entry, the notice it earned, and whether it is the previous entry kept as it was. */
interface Settled<Entry> {
  readonly entry: Entry;
  readonly notice: string | undefined;
  readonly kept: boolean;
}

const resolveService = Effect.fn("StackLock.resolveService")(function* (
  kind: NonDatabaseKind,
  request: ServiceRequest,
  majorVersion: number,
  previous: ServiceLock | undefined,
  source: LinkedSource,
) {
  const resolved = yield* resolvePinFor(kind, request, majorVersion, previous, source);
  return {
    entry: {
      specifier: request.specifier,
      ...(resolved.linked === undefined ? {} : { linked: resolved.linked }),
      resolution: resolved.resolution,
      resolved: resolved.pin,
    },
    notice: resolved.notice,
    kept: resolved.kept,
  } satisfies Settled<ServiceLock>;
});

const resolveDatabase = Effect.fn("StackLock.resolveDatabase")(function* (
  request: ServiceRequest,
  majorVersion: number,
  previous: DatabaseLock | undefined,
  source: LinkedSource,
) {
  const resolved = yield* resolvePinFor("database", request, majorVersion, previous, source);
  yield* Effect.annotateCurrentSpan({ "lock.database_line": pinLine(resolved.pin) });
  return {
    entry: {
      specifier: request.specifier,
      ...(resolved.linked === undefined ? {} : { linked: resolved.linked }),
      resolution: resolved.resolution,
      resolved: resolved.pin,
      majorVersion,
      line: pinLine(resolved.pin),
    },
    notice: resolved.notice,
    kept: resolved.kept,
  } satisfies Settled<DatabaseLock>;
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

/** Runs `effect` under the project lease that `supabase link` publishes `.link.json` under. */
export const withProjectLease = <A, E, R>(projectRoot: string, effect: Effect.Effect<A, E, R>) =>
  holdLease(projectRoot).pipe(Effect.andThen(effect), Effect.scoped);

/** A service the lock gained or moved to another release. */
interface LockChange {
  readonly service: ServiceKind;
  /** The release the lock held before; absent when the service had no entry yet. */
  readonly from: string | undefined;
  readonly to: string;
}

/** The pins a command runs and what it changed in the lock to get them. */
export interface LockedResolution {
  readonly selection: ArtifactSelection;
  /** Whether `supabase/supabase.lock` was written. */
  readonly written: boolean;
  /** Services resolved afresh; empty when the lock was used as-is. */
  readonly changes: ReadonlyArray<LockChange>;
  /** Services whose locked entry was kept. */
  readonly unchanged: ReadonlyArray<ServiceKind>;
}

const resolutionOf = (
  lock: Lock,
  previous: Lock | undefined,
  stale: ReadonlyMap<ServiceKind, string>,
  written: boolean,
): LockedResolution => ({
  selection: lockSelection(lock),
  written,
  changes: [...stale.keys()].map((service) => ({
    service,
    from: previous === undefined ? undefined : version(previous.services[service].resolved),
    to: version(lock.services[service].resolved),
  })),
  unchanged: artifactServiceKinds().filter((kind) => !stale.has(kind)),
});

/** The entry of a service that was not re-resolved, with the observation of a fresh probe when it has one. */
const probedService = (
  kind: ServiceKind,
  entry: ServiceLock,
  source: LinkedSource,
): ServiceLock => {
  const linked = linkedObservation(kind, entry, source);
  return {
    specifier: entry.specifier,
    ...(linked === undefined ? {} : { linked }),
    resolution: entry.resolution,
    resolved: entry.resolved,
  };
};

const probedDatabase = (entry: DatabaseLock, source: LinkedSource): DatabaseLock => {
  const linked = linkedObservation("database", entry, source);
  return {
    specifier: entry.specifier,
    ...(linked === undefined ? {} : { linked }),
    resolution: entry.resolution,
    resolved: entry.resolved,
    majorVersion: entry.majorVersion,
    line: entry.line,
  };
};

interface ResolvedServices {
  readonly services: Lock["services"];
  /** What the user should hear about fallbacks and kept entries. */
  readonly notices: ReadonlyArray<string>;
  /** Re-resolved services whose previous entry was kept as it was. */
  readonly kept: ReadonlyArray<ServiceKind>;
}

/**
 * Resolves the `redo` services afresh and keeps every other entry of `previous`. A probing source
 * also records its observation on kept entries that do not follow `linked`.
 */
const resolveServices = Effect.fn("StackLock.resolveServices")(function* (
  request: LockRequest,
  requests: ServiceRequests,
  previous: Lock | undefined,
  redo: ReadonlySet<ServiceKind>,
  source: LinkedSource,
) {
  yield* Effect.annotateCurrentSpan({ "lock.resolve_count": redo.size });
  const probes = (kind: ServiceKind) => source.probed && requests[kind].parsed.kind !== "linked";
  const service = (kind: NonDatabaseKind) => {
    const current = previous?.services[kind];
    return current === undefined || redo.has(kind)
      ? resolveService(kind, requests[kind], request.majorVersion, current, source)
      : Effect.succeed({
          entry: probes(kind) ? probedService(kind, current, source) : current,
          notice: undefined,
          kept: true,
        } satisfies Settled<ServiceLock>);
  };
  const currentDatabase = previous?.services.database;
  const settled = yield* Effect.all(
    {
      database:
        currentDatabase === undefined || redo.has("database")
          ? resolveDatabase(requests.database, request.majorVersion, currentDatabase, source)
          : Effect.succeed({
              entry: probes("database") ? probedDatabase(currentDatabase, source) : currentDatabase,
              notice: undefined,
              kept: true,
            } satisfies Settled<DatabaseLock>),
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
  const services: Lock["services"] = {
    database: settled.database.entry,
    rest: settled.rest.entry,
    auth: settled.auth.entry,
    realtime: settled.realtime.entry,
    storage: settled.storage.entry,
    imgproxy: settled.imgproxy.entry,
    functions: settled.functions.entry,
    studio: settled.studio.entry,
    pgmeta: settled.pgmeta.entry,
    mail: settled.mail.entry,
    analytics: settled.analytics.entry,
    pooler: settled.pooler.entry,
  };
  const kinds = artifactServiceKinds();
  return {
    services,
    notices: kinds.flatMap((kind) => settled[kind].notice ?? []),
    kept: kinds.filter((kind) => redo.has(kind) && settled[kind].kept),
  } satisfies ResolvedServices;
});

const assembleLock = (remote: LinkedRemote | undefined, services: Lock["services"]): Lock => ({
  $schema: LOCK_SCHEMA_URL,
  lockfileVersion: 1,
  ...(remote === undefined ? {} : { linked: remote }),
  services,
});

/** Writes `lock` as the project lock, after making sure git ignores the lease and staged writes. */
const publishLock = Effect.fn("StackLock.publish")(function* (request: LockRequest, lock: Lock) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
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
});

const lockEquivalence = Schema.toEquivalence(Lock);

/** Whether two locks pin and observe the same things; only the time of the observation may differ. */
const sameLock = (a: Lock, b: Lock) => {
  const untimed = (lock: Lock): Lock =>
    lock.linked === undefined ? lock : { ...lock, linked: { ...lock.linked, observedAt: "" } };
  return lockEquivalence(untimed(a), untimed(b));
};

/** A remote as a project ref, followed by the branch ref unless the branch is the project itself. */
const remoteLabel = (project: string, branchRef: string) =>
  branchRef === project ? project : `${project}/${branchRef}`;

const warnNotices = (output: Output["Service"], notices: ReadonlyArray<string>) =>
  Effect.forEach(notices, (notice) => output.warn(notice), { discard: true });

/**
 * Warnings that never block: the checkout is linked to another remote than the lock observed, and
 * this CLI bundles newer revisions of locked versions. Reads `.link.json` and bundled pins only.
 */
const lockWarnings = Effect.fn("StackLock.warn")(function* (
  request: LockRequest,
  requests: ServiceRequests,
  lock: Lock,
  output: Output["Service"],
) {
  const link = Option.flatten(yield* readProjectLink(request.projectRoot).pipe(Effect.option));
  if (Option.isSome(link)) {
    const target = link.value.active_branch;
    const observed = lock.linked;
    if (
      observed === undefined ||
      observed.project !== link.value.project.ref ||
      observed.branch.ref !== target.ref
    )
      yield* output.warn(
        `${observed === undefined ? `${LOCK_FILE} has no hosted observations` : `lock observed ${remoteLabel(observed.project, observed.branch.ref)}`}, this checkout targets ${remoteLabel(link.value.project.ref, target.ref)}; run supabase stack update`,
      );
  }
  const newer = yield* Effect.forEach(artifactServiceKinds(), (kind) =>
    bundledPin(kind, request.majorVersion).pipe(
      Effect.option,
      Effect.map((bundled) => {
        const locked = lock.services[kind].resolved;
        return Option.filter(
          bundled,
          (pin) =>
            !isExactRelease(requests[kind]) &&
            pin.upstreamVersion === locked.upstreamVersion &&
            pin.revision > locked.revision,
        ).pipe(
          Option.map((pin) => `${kind} ${version(locked)} → ${version(pin)}`),
          Option.toArray,
        );
      }),
    ),
  );
  const outdated = newer.flat();
  if (outdated.length > 0)
    yield* output.warn(
      `This CLI bundles newer revisions of locked versions: ${outdated.join(", ")}. Run supabase stack outdated to review, supabase stack update to adopt them.`,
    );
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
 * Frozen is explicit, or implied when `CI` is set and a lock exists. `linked` entries follow the
 * observations the lock stores, never a new probe.
 */
export const lockedResolution = (options: {
  readonly frozen: boolean;
  readonly output: Output["Service"];
}) =>
  Effect.fn("StackLock.select")(function* (
    request: LockRequest,
  ): Effect.fn.Return<
    LockedResolution,
    StackConfigError | LockResolutionError,
    FileSystem.FileSystem | Path.Path | Crypto.Crypto
  > {
    const requests = yield* requestsOf(request);
    const ci = yield* continuousIntegration;

    const { resolution, lock } = yield* Effect.gen(function* () {
      yield* holdLease(request.projectRoot);
      const { previous, stale } = yield* inspectLock(request, requests);
      const frozen = options.frozen || (ci && previous !== undefined);
      yield* Effect.annotateCurrentSpan({
        "lock.found": previous !== undefined,
        "lock.frozen": frozen,
        "lock.stale_count": stale.size,
      });
      if (previous !== undefined && stale.size === 0)
        return { resolution: resolutionOf(previous, previous, stale, false), lock: previous };
      if (frozen) return yield* unusableLock(stale, previous, "frozen");

      const resolved = yield* resolveServices(
        request,
        requests,
        previous,
        new Set(stale.keys()),
        storedSource(previous, false),
      );
      const lock = assembleLock(previous?.linked, resolved.services);
      yield* publishLock(request, lock);
      yield* options.output.info(
        [
          "Resolved service versions:",
          ...diffLines(previous, lock, stale),
          `${previous === undefined ? "Created" : "Updated"} ${LOCK_FILE}.`,
        ].join("\n"),
      );
      yield* warnNotices(options.output, resolved.notices);
      if (previous === undefined && ci)
        yield* options.output.warn(
          `Commit ${LOCK_FILE} so CI and your team run the same versions.`,
        );
      return { resolution: resolutionOf(lock, previous, stale, true), lock };
    }).pipe(Effect.scoped);
    yield* lockWarnings(request, requests, lock, options.output);
    return resolution;
  });

/** The pins a stack command runs; see {@link lockedResolution}. */
export const lockedSelection = (options: Parameters<typeof lockedResolution>[0]) => {
  const resolve = lockedResolution(options);
  return (request: LockRequest) =>
    resolve(request).pipe(Effect.map((resolution) => resolution.selection));
};

/** A service `stack update` locked to another release, and why. */
export interface UpdatedService extends LockChange {
  readonly reason: string;
}

/** What `stack update` did to `supabase/supabase.lock`. */
export interface LockUpdate {
  /** Whether `supabase/supabase.lock` was written. */
  readonly written: boolean;
  readonly changes: ReadonlyArray<UpdatedService>;
  /** Services whose locked entry was kept, excluding `stale` ones. */
  readonly unchanged: ReadonlyArray<ServiceKind>;
  /** Stale services that were not named; the lock still holds their old entries, with the reason. */
  readonly stale: ReadonlyArray<{ readonly service: ServiceKind; readonly reason: string }>;
}

const isExactRelease = ({ parsed }: ServiceRequest) =>
  parsed.kind === "release" && parsed.revision !== undefined;

const sameRelease = (before: ServiceLock | DatabaseLock, after: ServiceLock | DatabaseLock) =>
  before.specifier === after.specifier &&
  before.resolution === after.resolution &&
  version(before.resolved) === version(after.resolved);

/** The release an entry resolves to; the resolution is added when it is the only thing that differs. */
const describeMove = (
  before: ServiceLock | DatabaseLock | undefined,
  after: Pick<ServiceLock, "resolution" | "resolved">,
) =>
  before !== undefined &&
  version(before.resolved) === version(after.resolved) &&
  before.resolution !== after.resolution
    ? `${version(after.resolved)} (${after.resolution})`
    : version(after.resolved);

const linkedKinds = (requests: ServiceRequests) =>
  artifactServiceKinds().filter((kind) => requests[kind].parsed.kind === "linked");

/**
 * Re-resolves the named services (all when none are named) under the project lease and writes the
 * lock when an entry moved. Newest revisions come from the release host, bundled entries take
 * this CLI's pin, an exact `<U>-rN` entry that still answers its request is kept, and `linked`
 * entries follow a fresh hosted probe when one is available, retrying fallbacks. The probe runs
 * only when a `linked` entry is re-resolved; without one the stored observations apply.
 * Frozen mode does not apply: asking for newer versions is the point.
 */
export const updatedLock = <E, R>(options: {
  readonly services: ReadonlyArray<ServiceKind>;
  readonly probe: Effect.Effect<Option.Option<HostedProbe>, E, R>;
  readonly output: Output["Service"];
}) =>
  Effect.fn("StackLock.update")(function* (
    request: LockRequest,
  ): Effect.fn.Return<
    LockUpdate,
    StackConfigError | LockResolutionError | E,
    FileSystem.FileSystem | Path.Path | Crypto.Crypto | R
  > {
    const requests = yield* requestsOf(request);
    return yield* Effect.gen(function* () {
      yield* holdLease(request.projectRoot);
      const { previous, stale } = yield* inspectLock(request, requests);
      const named = options.services.length === 0 ? artifactServiceKinds() : options.services;
      // A lock has to hold every service, so a missing one is resolved whatever is named.
      const requested = new Set(
        previous === undefined
          ? artifactServiceKinds()
          : named.filter((kind) => stale.has(kind) || !isExactRelease(requests[kind])),
      );
      const probe = [...requested].some((kind) => requests[kind].parsed.kind === "linked")
        ? Option.getOrUndefined(yield* options.probe)
        : undefined;
      const observedAt = DateTime.formatIso(yield* DateTime.now);
      const source =
        probe === undefined
          ? storedSource(previous, true)
          : probedSource(previous, probe, observedAt, true);
      // Observations of another remote are no basis for the entries that follow them.
      const redo =
        probe !== undefined && !source.sameRemote
          ? new Set([...requested, ...linkedKinds(requests)])
          : requested;
      const resolved = yield* resolveServices(request, requests, previous, redo, source);
      const changes = [...redo].flatMap((kind): Array<UpdatedService> => {
        const before = previous?.services[kind];
        const after = resolved.services[kind];
        if (before !== undefined && sameRelease(before, after)) return [];
        return [
          {
            service: kind,
            from: before === undefined ? undefined : version(before.resolved),
            to: describeMove(before, after),
            reason: stale.get(kind) ?? updateReason(requests[kind].parsed),
          },
        ];
      });
      const skipped = [...stale].flatMap(([service, reason]) =>
        redo.has(service) ? [] : [{ service, reason }],
      );
      const unchanged = artifactServiceKinds().filter(
        (kind) =>
          !changes.some(({ service }) => service === kind) &&
          !skipped.some(({ service }) => service === kind),
      );
      const lock = assembleLock(source.remote, resolved.services);
      const written = previous === undefined || !sameLock(previous, lock);
      yield* Effect.annotateCurrentSpan({
        "lock.found": previous !== undefined,
        "lock.probed": probe !== undefined,
        "lock.resolve_count": redo.size,
        "lock.updated_count": changes.length,
        "lock.written": written,
      });
      yield* warnNotices(options.output, resolved.notices);
      if (!written) return { written, changes, unchanged, stale: skipped };
      yield* publishLock(request, lock);
      return { written, changes, unchanged, stale: skipped };
    }).pipe(Effect.scoped);
  });

const updateReason = (parsed: Specifier) =>
  parsed.kind === "release"
    ? `newest revision of ${parsed.upstream}`
    : parsed.kind === "linked"
      ? "follows the linked project"
      : "bundled with this CLI";

/** One service of a hosted probe as `supabase link` reports it. */
export interface LinkedService {
  readonly service: ServiceKind;
  /** What the platform reported; absent when it reports nothing or the probe failed. */
  readonly hosted: string | undefined;
  readonly locked: string;
  readonly resolution: ServiceLock["resolution"];
  /** Whether the entry's pin, resolution or hosted observation differs from the previous lock. */
  readonly changed: boolean;
}

/** What `supabase link` did to `supabase/supabase.lock`. */
export interface LinkedLock {
  /** Whether the lock was written; false when frozen or when nothing but the observation time changed. */
  readonly written: boolean;
  readonly frozen: boolean;
  readonly services: ReadonlyArray<LinkedService>;
  /** Re-resolved `linked` entries whose previous entry survived a transient failure or an unchanged fallback. */
  readonly kept: ReadonlyArray<ServiceKind>;
  /** The remote the lock now observes, when this link changed it. */
  readonly observing: string | undefined;
}

const hostedRaw = (probe: HostedProbe, kind: ServiceKind) => {
  const observed = probedObservation(probe, kind);
  return observed?._tag === "Observed" ? observed.raw : undefined;
};

const remoteChanged = (previous: Lock | undefined, probe: HostedProbe) =>
  previous?.linked === undefined ||
  previous.linked.project !== probe.remote.project ||
  previous.linked.branch.ref !== probe.remote.branch.ref;

/** How a frozen link's probe differs from the lock it leaves alone. */
const differences = (previous: Lock, probe: HostedProbe): ReadonlyArray<string> => [
  ...(previous.linked !== undefined &&
  previous.linked.project === probe.remote.project &&
  previous.linked.branch.ref === probe.remote.branch.ref
    ? []
    : [
        `the lock observed ${previous.linked === undefined ? "no remote" : remoteLabel(previous.linked.project, previous.linked.branch.ref)}, this link targets ${remoteLabel(probe.remote.project, probe.remote.branch.ref)}`,
      ]),
  ...artifactServiceKinds().flatMap((kind) => {
    if (probedObservation(probe, kind)?._tag === "Failed") return [];
    const locked = previous.services[kind].linked?.raw;
    const hosted = hostedRaw(probe, kind);
    return locked === hosted
      ? []
      : [`${kind} locked ${locked ?? "none"}, hosted ${hosted ?? "none"}`];
  }),
];

/**
 * Records a hosted probe in `supabase/supabase.lock` under the project lease: probes, updates the
 * per-service observations, re-resolves every `linked` entry, and sets the lock's remote. The lock
 * is written only when something but the time of the observation changed. While frozen (explicit,
 * or `CI` with an existing lock) the lock is left untouched and a difference from the probe is
 * warned about. `commit` runs last, still under the lease, so the caller publishes what belongs
 * with the lock in the same mutation.
 */
export const linkedLock = <E, R, E2, R2>(options: {
  readonly frozen: boolean;
  readonly probe: Effect.Effect<HostedProbe, E, R>;
  readonly commit: (result: LinkedLock) => Effect.Effect<void, E2, R2>;
  readonly output: Output["Service"];
}) =>
  Effect.fn("StackLock.link")(function* (
    request: LockRequest,
  ): Effect.fn.Return<
    LinkedLock,
    StackConfigError | LockResolutionError | E | E2,
    FileSystem.FileSystem | Path.Path | Crypto.Crypto | R | R2
  > {
    const requests = yield* requestsOf(request);
    const ci = yield* continuousIntegration;
    const kinds = artifactServiceKinds();
    return yield* Effect.gen(function* () {
      yield* holdLease(request.projectRoot);
      const { previous, stale } = yield* inspectLock(request, requests);
      const probe = yield* options.probe;
      const frozen = options.frozen || (ci && previous !== undefined);
      yield* Effect.annotateCurrentSpan({
        "lock.found": previous !== undefined,
        "lock.frozen": frozen,
        "lock.stale_count": stale.size,
      });
      const row = (kind: ServiceKind, lock: Lock | undefined): LinkedService => {
        const entry = (lock ?? previous)?.services[kind];
        const before = previous?.services[kind];
        return {
          service: kind,
          hosted: hostedRaw(probe, kind),
          locked: entry === undefined ? "none" : version(entry.resolved),
          resolution: entry?.resolution ?? "unlinked",
          changed:
            lock !== undefined &&
            (before === undefined ||
              !sameRelease(before, lock.services[kind]) ||
              before.linked?.raw !== lock.services[kind].linked?.raw),
        };
      };
      if (frozen) {
        const differing =
          previous === undefined
            ? [`there is no ${LOCK_FILE} to compare with`]
            : differences(previous, probe);
        if (differing.length > 0)
          yield* options.output.warn(
            `Hosted versions differ from ${LOCK_FILE}, which a frozen link leaves untouched: ${differing.join("; ")}. Run supabase stack update locally to record them.`,
          );
        const result: LinkedLock = {
          written: false,
          frozen,
          services: kinds.map((kind) => row(kind, undefined)),
          kept: [],
          observing: undefined,
        };
        yield* options.commit(result);
        return result;
      }

      const observedAt = DateTime.formatIso(yield* DateTime.now);
      const source = probedSource(previous, probe, observedAt, false);
      const redo = new Set([...stale.keys(), ...linkedKinds(requests)]);
      const resolved = yield* resolveServices(request, requests, previous, redo, source);
      const lock = assembleLock(source.remote, resolved.services);
      const written = previous === undefined || !sameLock(previous, lock);
      if (written) yield* publishLock(request, lock);
      yield* warnNotices(options.output, resolved.notices);
      const result: LinkedLock = {
        written,
        frozen,
        services: kinds.map((kind) => row(kind, lock)),
        kept: resolved.kept,
        observing: remoteChanged(previous, probe)
          ? remoteLabel(probe.remote.project, probe.remote.branch.ref)
          : undefined,
      };
      yield* options.commit(result);
      return result;
    }).pipe(Effect.scoped);
  });

/** One locked service as `stack outdated` reports it. */
export interface OutdatedService {
  readonly service: ServiceKind;
  readonly specifier: string;
  readonly resolution: ServiceLock["resolution"];
  readonly locked: string;
  /** What the linked project last reported, as the lock stored it; absent when nothing was observed. */
  readonly hosted: string | undefined;
  /** The release `stack update` would lock, with its resolution when only that differs; absent when it would keep the entry. */
  readonly update: string | undefined;
  /** This CLI's pin for the service. */
  readonly bundled: string;
  /** Why the entry no longer answers `config.toml`; absent when it does. */
  readonly stale: string | undefined;
  /** Why the newest release could not be determined; absent when it could. */
  readonly error: string | undefined;
}

/**
 * What `stack update` would change, per locked service, without the lease, a write, a download, or
 * a hosted probe: `linked` entries follow the stored observation, so a hosted version that moved
 * since `supabase link` shows only after `stack update` probes it. A stale entry is reported
 * without resolving: `start` or `stack update` resolves it against config. A failed resolution is
 * reported on its own row.
 */
export const outdatedServices = Effect.fn("StackLock.outdated")(function* (request: LockRequest) {
  const requests = yield* requestsOf(request);
  const { previous, stale } = yield* inspectLock(request, requests);
  if (previous === undefined) return yield* unusableLock(stale, previous, "reader");
  const lock = previous;
  const source = storedSource(lock, true);

  const row = Effect.fnUntraced(function* (kind: ServiceKind) {
    const entry = lock.services[kind];
    const requested = requests[kind];
    const reason = stale.get(kind);
    const bundled = yield* bundledPin(kind, request.majorVersion);
    const locked = version(entry.resolved);
    const newest: Effect.Effect<
      ResolvedPin | undefined,
      StackConfigError | LockResolutionError,
      Crypto.Crypto
    > =
      reason !== undefined || isExactRelease(requested)
        ? Effect.undefined
        : resolvePinFor(kind, requested, request.majorVersion, entry, source);
    const outcome = yield* newest.pipe(
      Effect.map((resolved) => ({ resolved, error: undefined })),
      Effect.catchTag("LockResolutionError", (error) =>
        Effect.succeed({ resolved: undefined, error: error.message }),
      ),
    );
    const resolved = outcome.resolved?.outage === undefined ? outcome.resolved : undefined;
    const error = outcome.error ?? outcome.resolved?.outage?.message;
    return {
      service: kind,
      specifier: entry.specifier,
      resolution: entry.resolution,
      locked,
      hosted: entry.linked?.raw,
      update:
        resolved === undefined ||
        (version(resolved.pin) === locked && resolved.resolution === entry.resolution)
          ? undefined
          : describeMove(entry, { resolution: resolved.resolution, resolved: resolved.pin }),
      bundled: version(bundled),
      stale: reason,
      error,
    } satisfies OutdatedService;
  });

  const rows = yield* Effect.forEach(artifactServiceKinds(), row, { concurrency: 4 });
  yield* Effect.annotateCurrentSpan({
    "lock.service_count": rows.length,
    "lock.stale_count": stale.size,
    "lock.outdated_count": rows.filter(({ update }) => update !== undefined).length,
    "lock.failed_count": rows.filter(({ error }) => error !== undefined).length,
  });
  return rows;
});
