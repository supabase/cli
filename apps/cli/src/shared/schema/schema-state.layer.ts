import { Clock, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { SchemaCheckpointError, SchemaLockError } from "./schema-errors.ts";
import { SchemaStateStore } from "./schema-state.service.ts";
import type { SchemaCheckpoint, SchemaDraftJournal } from "./schema-types.ts";
import { SchemaWorkspace } from "./schema-workspace.service.ts";

const CheckpointSchema = Schema.Struct({
  version: Schema.Literal(1),
  declarativeDigest: Schema.String,
  migrationHeadDigest: Schema.String,
  sourceFingerprint: Schema.optionalKey(Schema.String),
  desiredFingerprint: Schema.optionalKey(Schema.String),
  profile: Schema.String,
  scope: Schema.Literal("database"),
  engineVersion: Schema.String,
  artifactFormatVersion: Schema.Number,
  acceptedRenames: Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String })),
  exportManifestIdentity: Schema.optionalKey(Schema.String),
  catalogSnapshot: Schema.optionalKey(Schema.String),
  lastGenerateName: Schema.optionalKey(Schema.String),
  lastGenerateHazards: Schema.optionalKey(
    Schema.Struct({
      kinds: Schema.Array(Schema.String),
      destructive: Schema.Number,
      rewrite: Schema.Number,
      coverageGaps: Schema.Number,
    }),
  ),
  generatedMigrationVersions: Schema.optionalKey(Schema.Array(Schema.String)),
  destructiveMigrationVersions: Schema.optionalKey(Schema.Array(Schema.String)),
});

const JournalSchema = Schema.Struct({
  version: Schema.Literal(1),
  draftId: Schema.String,
  targetIdentity: Schema.String,
  startingMigrationHeadDigest: Schema.String,
  sourceFingerprint: Schema.String,
  plans: Schema.Array(
    Schema.Struct({
      planId: Schema.String,
      targetFingerprint: Schema.String,
      acceptedRenames: Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String })),
      segmentDigests: Schema.Array(Schema.String),
      hazards: Schema.Struct({
        kinds: Schema.Array(Schema.String),
        destructive: Schema.Number,
        rewrite: Schema.Number,
        coverageGaps: Schema.Number,
      }),
      actionStatuses: Schema.Array(Schema.Literals(["applied", "unapplied", "inDoubt"])),
      outcome: Schema.Literals(["applied", "failed", "partial"]),
    }),
  ),
  engineVersion: Schema.String,
  declarativelyAhead: Schema.Boolean,
  generated: Schema.optionalKey(Schema.Boolean),
  invalidationReason: Schema.optionalKey(Schema.String),
});

const STALE_LOCK_MS = 10 * 60 * 1000;

const checkpointError = (detail: string) =>
  new SchemaCheckpointError({
    detail,
    suggestion: "Fix or delete the schema checkpoint and rerun the command.",
  });

export const schemaStateLayer = Layer.effect(
  SchemaStateStore,
  Effect.gen(function* () {
    const workspace = yield* SchemaWorkspace;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const readDecoded = <A>(
      filePath: string,
      decode: (value: unknown) => A,
    ): Effect.Effect<Option.Option<A>, SchemaCheckpointError> =>
      Effect.gen(function* () {
        const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
        if (!exists) return Option.none();
        const raw = yield* fs
          .readFileString(filePath)
          .pipe(
            Effect.mapError((error) =>
              checkpointError(`Failed to read ${filePath}: ${error.message}`),
            ),
          );
        const parsed = yield* Effect.try({
          try: (): unknown => JSON.parse(raw),
          catch: () => checkpointError(`Malformed ${path.basename(filePath)}.`),
        });
        return Option.some(
          yield* Effect.try({
            try: () => decode(parsed),
            catch: (error) =>
              checkpointError(
                `Malformed ${path.basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`,
              ),
          }),
        );
      });

    const writeJson = (filePath: string, value: unknown) =>
      Effect.gen(function* () {
        yield* fs
          .makeDirectory(path.dirname(filePath), { recursive: true })
          .pipe(
            Effect.mapError((error) =>
              checkpointError(`Failed to create ${path.dirname(filePath)}: ${error.message}`),
            ),
          );
        yield* fs
          .writeFileString(filePath, `${JSON.stringify(value, null, 2)}\n`)
          .pipe(
            Effect.mapError((error) =>
              checkpointError(`Failed to write ${filePath}: ${error.message}`),
            ),
          );
      });

    return SchemaStateStore.of({
      readCheckpoint: readDecoded(
        workspace.checkpointPath,
        Schema.decodeUnknownSync(CheckpointSchema),
      ),
      writeCheckpoint: (checkpoint: SchemaCheckpoint) =>
        writeJson(workspace.checkpointPath, checkpoint),
      readJournal: readDecoded(workspace.journalPath, Schema.decodeUnknownSync(JournalSchema)),
      writeJournal: (journal: SchemaDraftJournal) => writeJson(workspace.journalPath, journal),
      clearJournal: Effect.gen(function* () {
        yield* fs
          .remove(workspace.journalPath)
          .pipe(
            Effect.catchTag("PlatformError", (error) =>
              error.reason._tag === "NotFound"
                ? Effect.void
                : Effect.fail(checkpointError(error.message)),
            ),
          );
      }),
      withLock: (effect) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(path.dirname(workspace.lockPath), { recursive: true }).pipe(
            Effect.mapError(
              (error) =>
                new SchemaLockError({
                  detail: `Failed to create lock directory: ${error.message}`,
                  suggestion: "Check permissions on .supabase/.",
                }),
            ),
          );
          const now = yield* Clock.currentTimeMillis;
          const exists = yield* fs
            .exists(workspace.lockPath)
            .pipe(Effect.orElseSucceed(() => false));
          if (exists) {
            const raw = yield* fs
              .readFileString(workspace.lockPath)
              .pipe(Effect.orElseSucceed(() => ""));
            const stamped = Number.parseInt(raw, 10);
            const stale = !Number.isFinite(stamped) || now - stamped > STALE_LOCK_MS;
            if (!stale) {
              return yield* new SchemaLockError({
                detail: "Another schema or migrations command is already running.",
                suggestion:
                  "Wait for it to finish, or remove .supabase/schema.lock if it is stale.",
              });
            }
          }
          yield* fs.writeFileString(workspace.lockPath, `${now}\n`).pipe(
            Effect.mapError(
              (error) =>
                new SchemaLockError({
                  detail: `Failed to acquire schema lock: ${error.message}`,
                  suggestion: "Check permissions on .supabase/schema.lock.",
                }),
            ),
          );
          return yield* effect.pipe(
            Effect.ensuring(fs.remove(workspace.lockPath).pipe(Effect.ignore)),
          );
        }),
    });
  }),
);
