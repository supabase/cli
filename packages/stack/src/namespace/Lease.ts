import { Effect, Exit, FileSystem, Option, Path, Schedule, Schema, Scope } from "effect";
import type { DatabaseSync } from "node:sqlite";
import { isSafeId } from "../identity/SafeId.ts";
import { retrySharingViolation } from "../internal/sharing-violation.ts";
import { namespaceError, type NamespaceError } from "./Capabilities.ts";
import * as Publication from "./Publication.ts";
import { removeEmptyDirectory } from "./drivers/FileSystem.ts";
import { acquireLock, errcode, isBusy, isMissing, takeLock } from "./drivers/Sqlite.ts";

/** What the current lease holder publishes: an owner's control endpoint, or a sweeper's marker. */
export const LeaseHolder = Schema.Union([
  Schema.Struct({
    role: Schema.Literal("owner"),
    port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
    pid: Schema.Int,
    release: Schema.String,
    lifetime: Schema.Literals(["session", "detached"]),
    startedAt: Schema.String,
    secret: Schema.String,
  }),
  Schema.Struct({ role: Schema.Literal("sweeper"), pid: Schema.Int, startedAt: Schema.String }),
]);
export type LeaseHolder = Schema.Schema.Type<typeof LeaseHolder>;

/** A live owner already holds this stack's lease. */
export class LeaseHeldError extends Schema.TaggedError<LeaseHeldError>()(
  "Namespace.LeaseHeldError",
  {
    stackId: Schema.String,
    message: Schema.String,
  },
) {}

/**
 * Obtained only by acquiring a stack's owner lease, for the life of that acquisition's scope.
 * `publishHolder` and `retractHolder` are the only way to write or clear this process's holder
 * record, so neither can run without the lease that makes the record meaningful.
 */
interface LeaseHandle {
  readonly stackId: string;
  readonly ownerLog: string;
  readonly publishHolder: (record: LeaseHolder) => Effect.Effect<void, NamespaceError>;
  readonly retractHolder: Effect.Effect<void, NamespaceError>;
}

export interface Interface {
  readonly acquireLease: (
    id: string,
  ) => Effect.Effect<LeaseHandle, LeaseHeldError | NamespaceError, Scope.Scope>;
  /** Reports whether any process currently holds the stack's owner lease. */
  readonly leased: (id: string) => Effect.Effect<boolean, NamespaceError>;
  /** Only meaningful while the lease is held; a record left by a dead holder is stale. */
  readonly readHolder: (id: string) => Effect.Effect<LeaseHolder | undefined, NamespaceError>;
  /** The file that receives the stack owner's stdout and stderr. */
  readonly ownerLog: (id: string) => string;
}

export const OWNER_FILE = "owner.json";
export const OWNER_LOG_FILE = "owner.log";

const checkId = (id: string): Effect.Effect<void, NamespaceError> =>
  isSafeId(id) ? Effect.void : Effect.fail(namespaceError("identity", `Invalid state id: ${id}`));

export interface Options {
  readonly root: string;
  readonly platform?: NodeJS.Platform;
  /** Whether the registry still has a saved document for this stack id. */
  readonly isRegistered: (id: string) => Effect.Effect<boolean, NamespaceError>;
  /** Observes a lease request that found the lease held and is waiting for it. */
  readonly onLeaseContended?: (id: string) => Effect.Effect<void>;
}

export const make = (
  options: Options,
): Effect.Effect<Interface, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stackRoot = (id: string) => path.join(options.root, id);
    const leasePath = (id: string) => path.join(stackRoot(id), "owner.lock");
    const ownerPath = (id: string) => path.join(stackRoot(id), OWNER_FILE);
    const ownerLog = (id: string) => path.join(stackRoot(id), OWNER_LOG_FILE);
    const retryRead = retrySharingViolation(options.platform);

    /** An open file that was unlinked: SQLite IOERR_VNODE on macOS, IOERR_FSTAT on Linux. */
    const isMoved = (error: NamespaceError) =>
      errcode(error.cause, 6922) || errcode(error.cause, 1802);
    const fileIdentity = (file: string) =>
      fs.stat(file).pipe(
        Effect.map((info) => `${info.dev}:${Option.getOrElse(info.ino, () => "")}`),
        Effect.option,
      );
    /**
     * Deletes an unregistered stack's lease file while it is still the file locked as `identity`;
     * `false` means it is still in place.
     */
    const removeLeaseFile = (id: string, identity: string) =>
      Effect.all([options.isRegistered(id), fileIdentity(leasePath(id))]).pipe(
        Effect.flatMap(([registered, current]) =>
          registered || !Option.contains(current, identity)
            ? Effect.void
            : fs.remove(leasePath(id), { force: true }),
        ),
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );

    const acquireLease = Effect.fn("Namespace.Lease.acquire")(function* (id: string) {
      yield* checkId(id);
      const target = leasePath(id);
      const scope = yield* Scope.Scope;
      let held: string | undefined;
      let unlinked = false;
      yield* Effect.addFinalizer(() =>
        held !== undefined
          ? (unlinked ? Effect.void : removeLeaseFile(id, held)).pipe(
              Effect.andThen(removeEmptyDirectory(stackRoot(id))),
              Effect.ignore,
            )
          : Effect.void,
      );
      let contended = false;
      const noteContention = Effect.suspend(() =>
        contended
          ? Effect.void
          : Effect.sync(() => (contended = true)).pipe(
              Effect.andThen(options.onLeaseContended?.(id) ?? Effect.void),
            ),
      );

      /** Closes `attemptScope`, noting contention first so busy is reported at most once. */
      const abandon = (
        attemptScope: Scope.Closeable,
        error: NamespaceError,
      ): Effect.Effect<never, NamespaceError> =>
        (isBusy(error) ? noteContention : Effect.void).pipe(
          Effect.andThen(Scope.close(attemptScope, Exit.void)),
          Effect.andThen(Effect.fail(error)),
        );

      /**
       * A waiter can open the lease file just before its holder unlinks it, and then lock the
       * unlinked file; comparing the path's file before opening and after locking rejects that.
       * Up to 8 quick retries cover that race; a busy failure propagates instead, so the retry
       * around this whole attempt (below) can wait it out on a slower schedule.
       */
      const tryOnce: Effect.Effect<{ readonly ownerLog: string }, NamespaceError, Scope.Scope> =
        Effect.gen(function* () {
          for (let attempt = 0; attempt < 8; attempt++) {
            // A releasing holder may remove the empty stack directory at any moment.
            yield* fs
              .makeDirectory(stackRoot(id), { recursive: true, mode: 0o700 })
              .pipe(Effect.mapError((cause) => namespaceError("lease", cause)));
            const before = yield* fileIdentity(target);
            const attemptScope = yield* Scope.fork(scope, "sequential");
            const connection = yield* acquireLock(target, "create").pipe(
              Scope.provide(attemptScope),
              Effect.map(Option.some),
              Effect.catchIf(isMissing, () => Effect.succeed(Option.none<DatabaseSync>())),
              Effect.catch((error) => abandon(attemptScope, error)),
            );
            if (Option.isNone(connection)) {
              yield* Scope.close(attemptScope, Exit.void);
              continue;
            }
            const locked = yield* takeLock(connection.value).pipe(
              Effect.as(true),
              Effect.catchIf(isMoved, () => Effect.succeed(false)),
              Effect.catch((error) => abandon(attemptScope, error)),
            );
            const after = locked ? yield* fileIdentity(target) : Option.none();
            if (Option.isSome(before) && Option.isSome(after) && before.value === after.value) {
              held = after.value;
              yield* Scope.addFinalizer(
                attemptScope,
                removeLeaseFile(id, after.value).pipe(
                  Effect.map((removed) => (unlinked = removed)),
                ),
              );
              return { ownerLog: ownerLog(id) };
            }
            yield* Scope.close(attemptScope, Exit.void);
          }
          return yield* namespaceError("lease", `The lease file of stack ${id} keeps changing`);
        });

      const outcome = yield* tryOnce.pipe(
        Effect.retry({
          schedule: Schedule.spaced("25 millis").pipe(Schedule.upTo({ duration: "500 millis" })),
          while: isBusy,
        }),
        Effect.catchIf(
          isBusy,
          () =>
            new LeaseHeldError({
              stackId: id,
              message: `Another owner holds the lease of stack ${id}`,
            }),
        ),
      );
      return {
        stackId: id,
        ownerLog: outcome.ownerLog,
        publishHolder: Effect.fn("Namespace.Lease.publishHolder")(function* (record: LeaseHolder) {
          const serialized = yield* Schema.encodeEffect(Schema.fromJsonString(LeaseHolder))(
            record,
          ).pipe(Effect.mapError((cause) => namespaceError("encode", cause)));
          // The lease already guarantees a single writer, so an atomic rename over any existing
          // record (a live one, or a crashed holder's stale one) is enough: a reader never sees a
          // gap where the file briefly doesn't exist, unlike a prior remove followed by a publish.
          yield* Publication.publish(fs, path, {
            target: ownerPath(id),
            content: serialized,
            platform: options.platform,
          });
        }),
        retractHolder: fs.remove(ownerPath(id), { force: true }).pipe(
          Effect.mapError((cause) => namespaceError("remove", cause)),
          Effect.withSpan("Namespace.Lease.retractHolder"),
        ),
      } satisfies LeaseHandle;
    });

    const leased = Effect.fn("Namespace.Lease.leased")(function* (id: string) {
      yield* checkId(id);
      return yield* Effect.scoped(
        acquireLock(leasePath(id), "existing").pipe(
          Effect.flatMap((connection) => takeLock(connection).pipe(Effect.as(false))),
          Effect.catchIf(isBusy, () => Effect.succeed(true)),
        ),
      ).pipe(
        // A lease file that is missing, or that its holder unlinked meanwhile, is not held.
        Effect.catchIf(
          (error) => isMissing(error) || isMoved(error),
          () => Effect.succeed(false),
        ),
      );
    });
    const decodeHolder = Schema.decodeEffect(Schema.fromJsonString(LeaseHolder));
    const readHolder = Effect.fn("Namespace.Lease.readHolder")(function* (id: string) {
      yield* checkId(id);
      const target = ownerPath(id);
      // The holder may retract its record at any moment, so a missing record is not an error.
      const text = yield* fs.readFileString(target).pipe(
        retryRead,
        Effect.map(Option.some),
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(Option.none<string>()),
        ),
        Effect.mapError((cause) => namespaceError("read", cause)),
      );
      if (Option.isNone(text)) return undefined;
      return yield* decodeHolder(text.value).pipe(
        Effect.mapError((cause) =>
          namespaceError("decode", `Unable to decode ${target}: ${cause}`),
        ),
      );
    });

    return { acquireLease, leased, readHolder, ownerLog };
  });
