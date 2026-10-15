import { Effect, Schema } from "effect";
import type { FileSystem, Path } from "effect";
import { namespaceError, type NamespaceError } from "../namespace/Capabilities.ts";
import { holdLock } from "../namespace/Lock.ts";
import { publish } from "../namespace/Publication.ts";
import { recreateStackAdvice } from "./database-reuse.ts";

/** The services whose migrations write schemas into the database. */
const schemaWriterServices = ["auth", "storage", "realtime", "analytics", "pooler"] as const;
export const SchemaWriterService = Schema.Literals(schemaWriterServices);
export type SchemaWriterService = typeof SchemaWriterService.Type;

/** Whether `service` owns schemas in the database, so it can never run an older upstream than the record. */
export const isSchemaWriter = Schema.is(SchemaWriterService);

/** The newest upstream version of each schema-owning service that migrated a database. */
export const SchemaWriters = Schema.Struct({
  auth: Schema.optionalKey(Schema.String),
  storage: Schema.optionalKey(Schema.String),
  realtime: Schema.optionalKey(Schema.String),
  analytics: Schema.optionalKey(Schema.String),
  pooler: Schema.optionalKey(Schema.String),
});
export interface SchemaWriters extends Schema.Schema.Type<typeof SchemaWriters> {}

const numericCore = /^v?(\d+(?:\.\d+)*)/u;
const components = (version: string): ReadonlyArray<number> =>
  numericCore
    .exec(version)?.[1]
    ?.split(".")
    .map((part) => Number.parseInt(part, 10)) ?? [];

/**
 * Orders upstream versions by their leading dotted number, such as `v2.196.0`, `2026.10.05-sha-…`
 * or `1.30`; a suffix is ignored and a version with no leading number is older than any other.
 */
export const compareUpstreamVersions = (a: string, b: string): number => {
  const left = components(a);
  const right = components(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return left.length === 0 && right.length > 0 ? -1 : left.length > 0 && right.length === 0 ? 1 : 0;
};

/** A schema-owning service was selected at an older upstream than one that already migrated the database. */
export class SchemaWriterDowngrade extends Schema.TaggedError<SchemaWriterDowngrade>()(
  "SchemaWriterDowngrade",
  {
    message: Schema.String,
    service: SchemaWriterService,
    selected: Schema.String,
    recorded: Schema.String,
  },
) {}

/** The failure to run `service` at `selected` against `writers`, or `undefined` when it may migrate. */
const schemaWriterDowngrade = (
  stackId: string,
  writers: SchemaWriters,
  service: SchemaWriterService,
  selected: string,
): SchemaWriterDowngrade | undefined => {
  const recorded = writers[service];
  if (recorded === undefined || compareUpstreamVersions(selected, recorded) >= 0) return undefined;
  return new SchemaWriterDowngrade({
    message: `${service} ${selected} is older than ${recorded}, which already migrated this database; downgrading does not restore the old schema, so ${recreateStackAdvice(stackId)}`,
    service,
    selected,
    recorded,
  });
};

/** The record's file name at a database instance root. */
export const schemaWritersFile = "schema-writers.json";
const WritersJson = Schema.fromJsonString(SchemaWriters);
const recordError = (cause: unknown) => namespaceError("schema-writers", cause);

/** The record at `instanceRoot`; a missing record means no writer has migrated yet. */
export const readSchemaWriters = Effect.fn("SchemaWriters.read")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  instanceRoot: string,
) {
  const file = path.join(instanceRoot, schemaWritersFile);
  return yield* fs.readFileString(file).pipe(
    Effect.flatMap(Schema.decodeEffect(WritersJson)),
    Effect.catchIf(
      (error) => "reason" in error && error.reason._tag === "NotFound",
      (): Effect.Effect<SchemaWriters> => Effect.succeed({}),
    ),
  );
}, Effect.mapError(recordError));

/** Forgets the record together with the data it describes. */
export const removeSchemaWriters = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  instanceRoot: string,
) => fs.remove(path.join(instanceRoot, schemaWritersFile), { force: true });

const writeSchemaWriters = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  instanceRoot: string,
  writers: SchemaWriters,
) =>
  Schema.encodeEffect(WritersJson)(writers).pipe(
    Effect.mapError(recordError),
    Effect.flatMap((content) =>
      publish(fs, path, {
        target: path.join(instanceRoot, schemaWritersFile),
        content,
      }),
    ),
  );

const recordLockFile = "schema-writers.lock";
const leaseFile = (service: SchemaWriterService) => `schema-writer-${service}.lock`;

/** Lock files that outlive a data clear, since another operation may hold them. */
export const schemaWriterLockFiles: ReadonlyArray<string> = [
  recordLockFile,
  ...schemaWriterServices.map(leaseFile),
];

const criticalSection = <A, E, R>(
  path: Path.Path,
  instanceRoot: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | NamespaceError, R> =>
  Effect.scoped(
    holdLock(
      path.join(instanceRoot, recordLockFile),
      "5 seconds",
      "The schema-writers record",
    ).pipe(Effect.andThen(effect)),
  );

const leaseBudget = "60 seconds";

/**
 * Holds every service's lease for the enclosing scope, so no writer is admitted or still
 * migrating while the caller clears or replaces the data and its record. Leases are taken in
 * service order, and a writer holds only one, so waiting here cannot form a cycle.
 */
export const holdSchemaWriterLeases = Effect.fn("SchemaWriters.holdAll")(function* (
  path: Path.Path,
  instanceRoot: string,
) {
  for (const service of schemaWriterServices)
    yield* holdLock(
      path.join(instanceRoot, leaseFile(service)),
      leaseBudget,
      `The ${service} schema writer`,
    );
});

/** Runs `effect` with every schema-writer lease held; see {@link holdSchemaWriterLeases}. */
export const withSchemaWriterLeases = <A, E, R>(
  path: Path.Path,
  instanceRoot: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | NamespaceError, R> =>
  Effect.scoped(holdSchemaWriterLeases(path, instanceRoot).pipe(Effect.andThen(effect)));

interface SchemaWriterSelection {
  readonly stackId: string;
  readonly instanceRoot: string;
  readonly service: SchemaWriterService;
  readonly version: string;
}

/** Fails when the record already holds a newer `service` than `version`, without touching it. */
export const checkSchemaWriter = Effect.fn("SchemaWriters.check")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  selection: SchemaWriterSelection,
) {
  const writers = yield* readSchemaWriters(fs, path, selection.instanceRoot);
  const downgrade = schemaWriterDowngrade(
    selection.stackId,
    writers,
    selection.service,
    selection.version,
  );
  yield* Effect.annotateCurrentSpan({
    "schema_writers.service": selection.service,
    "schema_writers.outcome": downgrade === undefined ? "allowed" : "downgrade",
  });
  if (downgrade !== undefined) return yield* downgrade;
});

/**
 * Holds `service`'s lease for the enclosing scope, then raises the record to `version` and fsyncs
 * it; fails with {@link SchemaWriterDowngrade} when the record is newer. Callers release the lease
 * once the migration completes, and a crashed holder's lease dies with its process.
 */
export const holdSchemaWriter = Effect.fn("SchemaWriters.hold")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  selection: SchemaWriterSelection,
) {
  yield* holdLock(
    path.join(selection.instanceRoot, leaseFile(selection.service)),
    leaseBudget,
    `The ${selection.service} schema writer`,
  );
  const outcome = yield* criticalSection(
    path,
    selection.instanceRoot,
    Effect.gen(function* () {
      const writers = yield* readSchemaWriters(fs, path, selection.instanceRoot);
      const downgrade = schemaWriterDowngrade(
        selection.stackId,
        writers,
        selection.service,
        selection.version,
      );
      if (downgrade !== undefined) return yield* downgrade;
      const recorded = writers[selection.service];
      if (recorded !== undefined && compareUpstreamVersions(selection.version, recorded) === 0)
        return "unchanged" as const;
      yield* writeSchemaWriters(fs, path, selection.instanceRoot, {
        ...writers,
        [selection.service]: selection.version,
      });
      return "raised" as const;
    }),
  ).pipe(
    Effect.tapError((error) =>
      Effect.annotateCurrentSpan({
        "schema_writers.outcome": error._tag === "SchemaWriterDowngrade" ? "downgrade" : "error",
      }),
    ),
  );
  yield* Effect.annotateCurrentSpan({
    "schema_writers.service": selection.service,
    "schema_writers.outcome": outcome,
  });
});

const newest = (current: string | undefined, other: string | undefined) =>
  current === undefined || (other !== undefined && compareUpstreamVersions(other, current) > 0)
    ? other
    : current;

/**
 * Restore step one: raises every service in the record to at least `snapshot`'s version and
 * fsyncs it, so the record stays at least as new as the data about to be published.
 */
export const raiseSchemaWritersTo = Effect.fn("SchemaWriters.raiseTo")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  instanceRoot: string,
  snapshot: SchemaWriters,
) {
  yield* criticalSection(
    path,
    instanceRoot,
    Effect.gen(function* () {
      const current = yield* readSchemaWriters(fs, path, instanceRoot);
      const raised: { -readonly [K in SchemaWriterService]?: string } = {};
      for (const service of schemaWriterServices) {
        const version = newest(current[service], snapshot[service]);
        if (version !== undefined) raised[service] = version;
      }
      yield* writeSchemaWriters(fs, path, instanceRoot, raised);
    }),
  );
});

/** Restore step three: sets the record to the snapshot's, now that its data is published. */
export const setSchemaWriters = Effect.fn("SchemaWriters.set")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  instanceRoot: string,
  snapshot: SchemaWriters,
) {
  yield* criticalSection(path, instanceRoot, writeSchemaWriters(fs, path, instanceRoot, snapshot));
});

/** Encodes a record for a snapshot entry. */
export const encodeSchemaWriters = (writers: SchemaWriters) =>
  Schema.encodeEffect(WritersJson)(writers).pipe(Effect.mapError(recordError));

/** Decodes the record stored in a snapshot entry. */
export const decodeSchemaWriters = (text: string) =>
  Schema.decodeEffect(WritersJson)(text).pipe(Effect.mapError(recordError));
