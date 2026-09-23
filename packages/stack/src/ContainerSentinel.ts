import {
  Context,
  Crypto,
  Data,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  Ref,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- FIFO descriptors must be held by the host process itself.
import { closeSync, constants, openSync, readSync, writeSync } from "node:fs";

export const Owner = Schema.Struct({
  generation: Schema.String,
  mutationFifoPath: Schema.String,
});
export interface Owner extends Schema.Schema.Type<typeof Owner> {}

export interface Interface {
  readonly owner: Owner | undefined;
}

export class Service extends Context.Service<Service, Interface>()(
  "@supabase/stack/ContainerSentinel",
) {}

export const mutationLeaseScript = 'exec 3<>"$1"; shift; exec "$@"';

class ContainerSentinelError extends Data.TaggedError("ContainerSentinelError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface Handle {
  readonly engine: string;
  readonly owner: Owner;
  readonly close: Effect.Effect<void, ContainerSentinelError>;
  readonly failure: Effect.Effect<never, ContainerSentinelError>;
}

const script = String.raw`
set -eu
engine=$1
stack_id=$2
generation=$3
owner_fifo=$4
mutation_fifo=$5
mkfifo "$owner_fifo" "$mutation_fifo"
trap 'rm -f "$owner_fifo" "$mutation_fifo"' EXIT
exec 9<>"$owner_fifo"
exec 8<"$owner_fifo"
exec 7<>"$mutation_fifo"
exec 6<"$mutation_fifo"
printf 'watching\n' >&3
IFS= read -r _ <&8
IFS= read -r _ <&6
exec 9>&-
exec 7>&-

engine_output() {
  while ! output=$("$engine" "$@" 2>/dev/null); do sleep 1; done
  printf '%s' "$output"
}

remove_one() {
  id=$1
  while ! "$engine" rm --force "$id" >/dev/null 2>&1; do
    ids=$(engine_output ps --all --quiet --no-trunc --filter "id=$id")
    [ -z "$ids" ] && return
    sleep 1
  done
}

remove_stale() {
  ids=$(engine_output ps --all --quiet --no-trunc --filter "label=com.supabase.stack=$stack_id")
  for id in $ids; do remove_one "$id"; done
}

verify_stale_absent() {
  ids=$(engine_output ps --all --quiet --no-trunc --filter "label=com.supabase.stack=$stack_id")
  [ -z "$ids" ]
}

cleanup_generation() {
  ids=$(engine_output ps --all --quiet --no-trunc --filter "label=com.supabase.stack=$stack_id" --filter "label=com.supabase.host-generation=$generation")
  for id in $ids; do remove_one "$id"; done
}

verify_generation_absent() {
  pass=0
  while [ "$pass" -lt 3 ]; do
    ids=$(engine_output ps --all --quiet --no-trunc --filter "label=com.supabase.stack=$stack_id" --filter "label=com.supabase.host-generation=$generation")
    [ -z "$ids" ] || return 1
    pass=$((pass + 1))
    [ "$pass" -lt 3 ] && sleep 0.25
  done
  return 0
}

remove_stale
until verify_stale_absent; do
  remove_stale
done

printf 'ready\n' >&4
while IFS= read -r _ <&8; do :; done
cleanup_generation
while IFS= read -r _ <&6; do :; done
cleanup_generation
until verify_generation_absent; do cleanup_generation; done
`;

export const start = Effect.fn("ContainerSentinel.start")(function* (options: {
  readonly directory: string;
  readonly stackId: string;
  readonly engine: string;
}) {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const generation = yield* crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ContainerSentinelError({ operation: "identity", message: String(cause), cause }),
    ),
  );
  if (String(process.platform) === "win32") return undefined;
  const directory = path.join(options.directory, "container-sentinels");
  yield* fs
    .makeDirectory(directory, { recursive: true })
    .pipe(
      Effect.mapError(
        (cause) =>
          new ContainerSentinelError({ operation: "directory", message: String(cause), cause }),
      ),
    );
  const fifoPath = path.join(directory, `owner-${generation}.fifo`);
  const mutationFifoPath = path.join(directory, `mutation-${generation}.fifo`);
  yield* waitForPreviousFifos(directory, fifoPath, mutationFifoPath, fs);
  const childRef = yield* Ref.make<ChildProcessHandle | undefined>(undefined);
  const ownerFdRef = yield* Ref.make<number | undefined>(undefined);
  const mutationFdRef = yield* Ref.make<number | undefined>(undefined);
  const startup = yield* Effect.exit(
    Effect.gen(function* () {
      const child = yield* spawner
        .spawn(
          ChildProcess.make(
            "/bin/sh",
            [
              "-c",
              script,
              "supabase-container-sentinel",
              options.engine,
              options.stackId,
              generation,
              fifoPath,
              mutationFifoPath,
            ],
            {
              detached: true,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
              additionalFds: {
                fd3: { type: "output" },
                fd4: { type: "output" },
              },
            },
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new ContainerSentinelError({ operation: "spawn", message: String(cause), cause }),
          ),
        );
      yield* Ref.set(childRef, child);
      const watching = child.getOutputFd(3).pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.runHead,
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new ContainerSentinelError({
                  operation: "startup",
                  message: "Sentinel watch stream closed",
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );
      yield* watching.pipe(
        Effect.timeout("30 seconds"),
        Effect.mapError((cause) =>
          cause instanceof ContainerSentinelError
            ? cause
            : new ContainerSentinelError({ operation: "watch", message: String(cause), cause }),
        ),
      );
      const ownerFd = yield* Effect.try({
        try: () => openSync(fifoPath, "w"),
        catch: (cause) =>
          new ContainerSentinelError({ operation: "open", message: String(cause), cause }),
      });
      yield* Ref.set(ownerFdRef, ownerFd);
      const mutationFd = yield* Effect.try({
        try: () => openSync(mutationFifoPath, "w"),
        catch: (cause) =>
          new ContainerSentinelError({ operation: "open", message: String(cause), cause }),
      });
      yield* Ref.set(mutationFdRef, mutationFd);
      yield* Effect.try({
        try: () => {
          writeSync(ownerFd, Buffer.from("host-ready\n"));
          writeSync(mutationFd, Buffer.from("host-ready\n"));
        },
        catch: (cause) =>
          new ContainerSentinelError({ operation: "open", message: String(cause), cause }),
      });
      const readiness = child.getOutputFd(4).pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.runHead,
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new ContainerSentinelError({
                  operation: "startup",
                  message: "Sentinel readiness stream closed",
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );
      yield* readiness.pipe(
        Effect.timeout("2 minutes"),
        Effect.mapError((cause) =>
          cause instanceof ContainerSentinelError
            ? cause
            : new ContainerSentinelError({ operation: "startup", message: String(cause), cause }),
        ),
      );
      yield* Effect.asVoid(
        child.unref.pipe(
          Effect.mapError(
            (cause) =>
              new ContainerSentinelError({ operation: "unref", message: String(cause), cause }),
          ),
        ),
      );
      return { child, ownerFd, mutationFd };
    }),
  );
  if (Exit.isFailure(startup)) {
    const ownerFd = yield* Ref.get(ownerFdRef);
    const mutationFd = yield* Ref.get(mutationFdRef);
    const child = yield* Ref.get(childRef);
    yield* Effect.sync(() => {
      if (ownerFd !== undefined) closeSync(ownerFd);
      if (mutationFd !== undefined) closeSync(mutationFd);
    }).pipe(Effect.ignoreCause);
    if (child !== undefined)
      yield* child
        .kill({ killSignal: "SIGTERM", forceKillAfter: "2 seconds" })
        .pipe(Effect.ignoreCause);
    if (child !== undefined) yield* child.exitCode.pipe(Effect.timeout("5 seconds"), Effect.ignore);
    yield* fs.remove(fifoPath).pipe(Effect.ignore);
    yield* fs.remove(mutationFifoPath).pipe(Effect.ignore);
    return yield* Effect.failCause(startup.cause);
  }
  const fifo = startup.value;
  let closed = false;
  const close = Effect.suspend(() => {
    if (!closed) {
      closed = true;
      return closeFifos(fifo).pipe(
        Effect.andThen(awaitSentinel(fifo.child).pipe(Effect.timeout("30 seconds"))),
        Effect.mapError((cause) =>
          cause instanceof ContainerSentinelError
            ? cause
            : new ContainerSentinelError({ operation: "cleanup", message: String(cause), cause }),
        ),
      );
    }
    return awaitSentinel(fifo.child).pipe(
      Effect.timeout("30 seconds"),
      Effect.mapError((cause) =>
        cause instanceof ContainerSentinelError
          ? cause
          : new ContainerSentinelError({ operation: "cleanup", message: String(cause), cause }),
      ),
    );
  });
  yield* Effect.addFinalizer(() =>
    close.pipe(
      Effect.catch((cause) => Effect.logError("Container sentinel cleanup failed", cause)),
    ),
  );
  return {
    engine: options.engine,
    owner: { generation, mutationFifoPath },
    close,
    failure: waitForFailure(fifo.child, () => closed),
  };
});

export const removeOwned = Effect.fn("ContainerSentinel.removeOwned")(function* (options: {
  readonly engine: string;
  readonly stackId: string;
  readonly generation?: string;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const run = Effect.fn("ContainerSentinel.runEngineCommand")(function* (
    args: ReadonlyArray<string>,
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(options.engine, args, {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          }),
        );
        const [stdout, stderr, code] = yield* Effect.all(
          [
            child.stdout.pipe(Stream.decodeText, Stream.mkString),
            child.stderr.pipe(Stream.decodeText, Stream.mkString),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        if (Number(code) !== 0)
          return yield* new ContainerSentinelError({
            operation: args[0] ?? "engine",
            message: stderr.trim() || `Container engine exited with ${code}`,
          });
        return stdout.trim();
      }),
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof ContainerSentinelError
          ? cause
          : new ContainerSentinelError({
              operation: args[0] ?? "engine",
              message: String(cause),
              cause,
            }),
      ),
    );
  });
  const label = `label=com.supabase.stack=${options.stackId}`;
  const filters = ["--filter", label];
  if (options.generation !== undefined)
    filters.push("--filter", `label=com.supabase.host-generation=${options.generation}`);
  const ownedIds = () => run(["ps", "--all", "--quiet", "--no-trunc", ...filters]);
  const removeOne = Effect.fn("ContainerSentinel.removeOne")(function* (id: string) {
    const removed = yield* run(["rm", "--force", id]).pipe(Effect.exit);
    if (Exit.isSuccess(removed)) return;
    const present = yield* run(["ps", "--all", "--quiet", "--no-trunc", "--filter", `id=${id}`]);
    if (present !== "") return yield* Effect.failCause(removed.cause);
  });
  yield* ownedIds().pipe(
    Effect.flatMap((output) =>
      Effect.forEach(
        output.split("\n").filter((id) => id.length > 0),
        removeOne,
        {
          discard: true,
          concurrency: 1,
        },
      ),
    ),
  );
  const verify = ownedIds().pipe(Effect.map((ids) => ids.length === 0));
  const confirmed = yield* verify.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("250 millis").pipe(Schedule.upTo({ times: 3 })),
      until: (absent) => absent,
    }),
    Effect.timeout("30 seconds"),
    Effect.mapError((cause) =>
      cause instanceof ContainerSentinelError
        ? cause
        : new ContainerSentinelError({ operation: "verify", message: String(cause), cause }),
    ),
  );
  if (!confirmed)
    return yield* new ContainerSentinelError({
      operation: "verify",
      message: "Owned containers remain after cleanup",
    });
});

const waitForPreviousFifos = Effect.fn("ContainerSentinel.waitForPreviousFifos")(function* (
  directory: string,
  currentOwner: string,
  currentMutation: string,
  fs: FileSystem.FileSystem,
) {
  const entries = yield* fs
    .readDirectory(directory)
    .pipe(
      Effect.mapError(
        (cause) =>
          new ContainerSentinelError({ operation: "reconcile", message: String(cause), cause }),
      ),
    );
  for (const entry of entries) {
    if (!/^(?:owner|mutation)-[a-f0-9-]+\.fifo$/u.test(entry)) continue;
    const fifoPath = `${directory}/${entry}`;
    if (fifoPath === currentOwner || fifoPath === currentMutation) continue;
    const descriptor = yield* Effect.try({
      try: () => openSync(fifoPath, constants.O_RDONLY | constants.O_NONBLOCK),
      catch: (cause) =>
        new ContainerSentinelError({ operation: "reconcile", message: String(cause), cause }),
    }).pipe(
      Effect.catch((cause) => {
        const underlying = cause.cause;
        return underlying instanceof Error && "code" in underlying && underlying.code === "ENOENT"
          ? Effect.void
          : Effect.fail(cause);
      }),
    );
    if (descriptor === undefined) continue;
    const settled = Effect.try({
      try: () => {
        const buffer = Buffer.alloc(1);
        try {
          return readSync(descriptor, buffer, 0, buffer.length, null) === 0;
        } catch (cause) {
          if (
            typeof cause === "object" &&
            cause !== null &&
            "code" in cause &&
            cause.code === "EAGAIN"
          )
            return false;
          throw cause;
        }
      },
      catch: (cause) =>
        new ContainerSentinelError({ operation: "reconcile", message: String(cause), cause }),
    }).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("100 millis"),
        until: (closed) => closed,
      }),
      Effect.ensuring(Effect.sync(() => closeSync(descriptor))),
    );
    yield* settled;
    yield* fs
      .remove(fifoPath, { force: true })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ContainerSentinelError({ operation: "reconcile", message: String(cause), cause }),
        ),
      );
  }
});

const closeFifos = Effect.fn("ContainerSentinel.closeFifos")(function* (fifo: {
  readonly ownerFd: number;
  readonly mutationFd: number;
}) {
  yield* Effect.try({
    try: () => {
      closeSync(fifo.ownerFd);
      closeSync(fifo.mutationFd);
    },
    catch: () => undefined,
  });
});

const awaitSentinel = Effect.fn("ContainerSentinel.awaitSentinel")(function* (
  child: ChildProcessHandle,
) {
  const code = yield* child.exitCode.pipe(
    Effect.map(Number),
    Effect.mapError(
      (cause) =>
        new ContainerSentinelError({ operation: "cleanup", message: String(cause), cause }),
    ),
  );
  if (code !== 0)
    return yield* new ContainerSentinelError({
      operation: "cleanup",
      message: `Sentinel exited with status ${code}`,
    });
});

const waitForFailure = Effect.fn("ContainerSentinel.waitForFailure")(function* (
  child: ChildProcessHandle,
  isClosing: () => boolean,
) {
  const code = yield* child.exitCode.pipe(
    Effect.map(Number),
    Effect.mapError(
      (cause) => new ContainerSentinelError({ operation: "watch", message: String(cause), cause }),
    ),
  );
  if (isClosing() && code === 0) return yield* Effect.never;
  return yield* new ContainerSentinelError({
    operation: "watch",
    message: `Sentinel exited unexpectedly with status ${code}`,
  });
});
