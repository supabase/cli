import { Cause, Effect, Exit, FileSystem, Option, Schema } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- readiness is an inherited launcher descriptor.
import { closeSync, writeSync } from "node:fs";
import * as Network from "../src/Network.ts";
import { runStackHost, StackHostError } from "../src/StackHost.ts";
import { watchEntry } from "./watch-entry.ts";

/**
 * A real owner entrypoint, identical to `internal/host-process.ts`, except it overrides
 * `Network.ShutdownDrainDeadline` to wait for a `release` file in `gateDir` instead of racing a
 * real timer, so a test can hold a shutdown's drain open deterministically from outside the
 * subprocess. Production code never reads this from an environment variable or `Config`; only
 * this dedicated test fixture supplies a different value.
 */
const awaitRelease = (gateDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // Subscribes before signaling "waiting" below, so a `release` written the instant a test
    // observes that signal can never land in the gap between the signal and this watch attaching.
    const released = yield* watchEntry(gateDir, "release", true);
    // Marks entry into the drain-deadline wait itself, so a test can subscribe to this instead
    // of a sleep before it is safe to act on the assumption that drain has actually begun.
    yield* fs.writeFileString(`${gateDir}/waiting`, "");
    yield* released;
  });

const writeLine = (value: unknown) =>
  Effect.gen(function* () {
    const serialized = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
      value,
    ).pipe(
      Effect.mapError(
        (cause) => new StackHostError({ operation: "ready", message: String(cause), cause }),
      ),
    );
    yield* Effect.try({
      try: () => writeSync(3, Buffer.from(`${serialized}\n`, "utf8")),
      catch: (cause) => new StackHostError({ operation: "ready", message: String(cause), cause }),
    });
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        try {
          closeSync(3);
        } catch {
          // The parent may close the inherited descriptor during cancellation.
        }
      }),
    ),
  );

const [stateRoot, cacheRoot, stackId, gateDir, ...rest] = process.argv.slice(2);

const program = Effect.gen(function* () {
  if (
    stateRoot === undefined ||
    cacheRoot === undefined ||
    stackId === undefined ||
    gateDir === undefined ||
    rest.length > 0
  )
    return yield* new StackHostError({
      operation: "startup",
      message: "Expected stateRoot, cacheRoot, stackId and gateDir",
    });
  let reported = false;
  const report = (value: unknown) =>
    Effect.suspend(() => {
      if (reported) return Effect.void;
      reported = true;
      return writeLine(value);
    });
  yield* runStackHost({
    stateRoot,
    cacheRoot,
    stackId,
    onReady: ({ endpoint, secret }) => report({ type: "ready", endpoint, secret }),
  }).pipe(
    Effect.provideService(Network.ShutdownDrainDeadline, awaitRelease(gateDir)),
    Effect.catchCause((cause) => {
      const failure = Option.getOrUndefined(Cause.findErrorOption(cause));
      return report({
        type: "error",
        message: failure?.message ?? Cause.pretty(cause),
        ...(failure?.reason === undefined ? {} : { reason: failure.reason }),
      }).pipe(Effect.exit, Effect.andThen(Effect.failCause(cause)));
    }),
  );
});

const flushed = (stream: NodeJS.WriteStream) =>
  Effect.callback<void>((resume) => {
    stream.write("", () => resume(Effect.void));
  }).pipe(Effect.timeoutOption("1 second"));

await Effect.runPromise(
  program.pipe(
    Effect.exit,
    Effect.tap((exit) =>
      Exit.isFailure(exit)
        ? Effect.sync(() => process.stderr.write(`${Cause.pretty(exit.cause)}\n`))
        : Effect.void,
    ),
    Effect.tap(() => Effect.all([flushed(process.stdout), flushed(process.stderr)])),
    Effect.flatMap((exit) => Effect.sync(() => process.exit(Exit.isSuccess(exit) ? 0 : 1))),
  ),
);
