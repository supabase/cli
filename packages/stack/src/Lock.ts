import { Effect, FileSystem, Option, Path, Predicate, Record, Schema } from "effect";
import {
  ArtifactPin,
  artifactSourceService,
  type ArtifactSelection,
  type ServiceKind,
} from "./Artifacts.ts";
import { SLIM_IMAGE_GHCR_REGISTRY } from "./preparation/SlimEndpoints.ts";
import { publish } from "./StackNamespace.ts";

/** The `$schema` value every v1 lock is written with, because older CLIs require it. */
export const LOCK_SCHEMA_URL = "https://supabase.com/docs/cli/supabase-lock/v1.schema.json";

/** Where the v1 lock schema is hosted; reads accept it as `$schema` so a later release can write it. */
export const HOSTED_LOCK_SCHEMA_URL = "https://supabase.com/schemas/supabase-lock/v1.json";

const LOCK_VERSION = 1;

/** `supabase.lock` inside the project's `supabase` directory. */
const lockPath = (path: Path.Path, projectRoot: string): string =>
  path.join(projectRoot, "supabase", "supabase.lock");

/** What the hosted project reported for a service, kept even when a specifier overrides it. */
const LinkedVersion = Schema.Struct({ raw: Schema.String, version: Schema.String }).annotate({
  identifier: "LinkedVersion",
});

/**
 * How the specifier became `resolved`: as requested, or as the bundled pin because a `linked`
 * request had no project, no observable version, or no published release.
 */
const Resolution = Schema.Literals(["resolved", "unlinked", "unobserved", "unpublished"]);

/** `<producer>:<tag>@sha256:<digest>`, the part of a canonical image after the registry prefix. */
const IMAGE_REFERENCE = /^([^/:@]+):([^/:@]+)@sha256:[0-9a-f]{64}$/u;

/**
 * The image of a pin must be the digest-pinned GHCR release `<upstreamVersion>-r<revision>` of the
 * service's producer; download mirrors are derived from it when pulling, never recorded.
 */
const resolvedPin = (kind: ServiceKind) =>
  ArtifactPin.check(
    Schema.makeFilter((pin) => {
      const producer = artifactSourceService(kind);
      const tag = `${pin.upstreamVersion}-r${pin.revision}`;
      const canonical = `${SLIM_IMAGE_GHCR_REGISTRY}${producer}:${tag}@sha256:`;
      const match = pin.image.startsWith(SLIM_IMAGE_GHCR_REGISTRY)
        ? IMAGE_REFERENCE.exec(pin.image.slice(SLIM_IMAGE_GHCR_REGISTRY.length))
        : null;
      if (match === null) return `${kind} image "${pin.image}" must be ${canonical}<64 hex digits>`;
      if (match[1] !== producer)
        return `${kind} image "${pin.image}" is not a ${producer} image, expected ${canonical}<digest>`;
      return match[2] === tag
        ? undefined
        : `${kind} image "${pin.image}" is tagged ${match[2]} but the pin is ${tag}`;
    }),
  );

const serviceFields = (kind: ServiceKind) => ({
  /** The effective version request. */
  specifier: Schema.String,
  linked: Schema.optionalKey(LinkedVersion),
  resolution: Resolution,
  resolved: resolvedPin(kind),
});

const serviceLock = (kind: ServiceKind) =>
  Schema.Struct(serviceFields(kind)).annotate({ identifier: "ServiceLock" });

const DatabaseLock = Schema.Struct({
  ...serviceFields("database"),
  majorVersion: Schema.Int,
  line: Schema.Literals(["stock", "orioledb"]),
}).annotate({ identifier: "DatabaseLock" });

/** The remote the `linked` observations belong to: a project plus one of its branches. */
const LinkedRemote = Schema.Struct({
  project: Schema.String,
  branch: Schema.Struct({ ref: Schema.String, isDefault: Schema.Boolean }),
  observedAt: Schema.String,
});

/** The `supabase/supabase.lock` v1 document: the pin every stack service runs. */
export const Lock = Schema.Struct({
  $schema: Schema.Literal(LOCK_SCHEMA_URL),
  lockfileVersion: Schema.Literal(LOCK_VERSION),
  linked: Schema.optionalKey(LinkedRemote),
  services: Schema.Struct({
    database: DatabaseLock,
    rest: serviceLock("rest"),
    auth: serviceLock("auth"),
    realtime: serviceLock("realtime"),
    storage: serviceLock("storage"),
    imgproxy: serviceLock("imgproxy"),
    functions: serviceLock("functions"),
    studio: serviceLock("studio"),
    pgmeta: serviceLock("pgmeta"),
    mail: serviceLock("mail"),
    analytics: serviceLock("analytics"),
    pooler: serviceLock("pooler"),
  }),
});
export interface Lock extends Schema.Schema.Type<typeof Lock> {}

/** The lock declares a `lockfileVersion` newer than this build reads. */
export class LockUnsupportedVersionError extends Schema.TaggedError<LockUnsupportedVersionError>()(
  "LockUnsupportedVersionError",
  {
    path: Schema.String,
    found: Schema.Int,
    supported: Schema.Int,
    message: Schema.String,
  },
) {}

/** The lock, or a lock being written, is not a valid document of the supported version. */
export class LockInvalidError extends Schema.TaggedError<LockInvalidError>()("LockInvalidError", {
  path: Schema.String,
  message: Schema.String,
}) {}

/** Reading or writing the lock failed for a reason other than absence. */
export class LockIoError extends Schema.TaggedError<LockIoError>()("LockIoError", {
  path: Schema.String,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeVersion = Schema.decodeUnknownOption(
  Schema.Struct({ lockfileVersion: Schema.Int.check(Schema.isGreaterThan(LOCK_VERSION)) }),
);
const decodeLock = Schema.decodeUnknownEffect(Lock);

const withWrittenSchemaUrl = (document: unknown): unknown =>
  Predicate.isObject(document) && document["$schema"] === HOSTED_LOCK_SCHEMA_URL
    ? { ...document, $schema: LOCK_SCHEMA_URL }
    : document;

const sortedKeysReplacer = (_key: string, value: unknown): unknown =>
  Predicate.isObject(value) && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : value;

const encodeLock = Schema.encodeEffect(
  Schema.fromJsonString(Lock, { space: 2, replacer: sortedKeysReplacer }),
);

/** Reads `supabase/supabase.lock`, `None` when absent; takes no lease because writes are atomic renames. */
export const readLock = Effect.fn("Lock.read")(function* (projectRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = lockPath(path, projectRoot);
  const content = yield* fs.readFileString(file).pipe(
    Effect.map(Option.some),
    Effect.catchTag("PlatformError", (error) =>
      error.reason._tag === "NotFound"
        ? Effect.succeed(Option.none<string>())
        : Effect.fail(
            new LockIoError({
              path: file,
              message: `failed to read ${file}: ${error.message}`,
              cause: error,
            }),
          ),
    ),
  );
  if (Option.isNone(content)) {
    yield* Effect.annotateCurrentSpan({ "lock.found": false });
    return Option.none<Lock>();
  }
  const document = yield* decodeJson(content.value).pipe(
    Effect.mapError(
      (cause) =>
        new LockInvalidError({
          path: file,
          message: `${file} is not valid JSON: ${cause.message}`,
        }),
    ),
  );
  const newer = decodeVersion(document);
  if (Option.isSome(newer)) {
    return yield* new LockUnsupportedVersionError({
      path: file,
      found: newer.value.lockfileVersion,
      supported: LOCK_VERSION,
      message: `${file} has lockfileVersion ${newer.value.lockfileVersion}, but this CLI reads version ${LOCK_VERSION}; upgrade the CLI.`,
    });
  }
  const lock = yield* decodeLock(withWrittenSchemaUrl(document)).pipe(
    Effect.mapError(
      (cause) =>
        new LockInvalidError({
          path: file,
          message: `${file} is not a valid lock: ${cause.message}`,
        }),
    ),
  );
  yield* Effect.annotateCurrentSpan({ "lock.found": true });
  return Option.some(lock);
});

/** Atomically writes `supabase/supabase.lock` as sorted-key JSON, so equal locks are equal bytes. */
export const writeLock = Effect.fn("Lock.write")(function* (projectRoot: string, lock: Lock) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = lockPath(path, projectRoot);
  const json = yield* encodeLock(lock).pipe(
    Effect.mapError(
      (cause) =>
        new LockInvalidError({
          path: file,
          message: `refusing to write an invalid lock: ${cause.message}`,
        }),
    ),
  );
  const content = `${json}\n`;
  yield* Effect.gen(function* () {
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* publish(fs, path, { target: file, content, mode: 0o644 });
  }).pipe(
    Effect.mapError(
      (cause) =>
        new LockIoError({
          path: file,
          message: `failed to write ${file}: ${cause.message}`,
          cause,
        }),
    ),
  );
});

/** The pin each service runs under this lock. */
export const lockSelection = (lock: Lock): ArtifactSelection =>
  Record.map(lock.services, (service) => service.resolved);
