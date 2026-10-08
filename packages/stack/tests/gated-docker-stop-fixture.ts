import { Cause, Effect, Exit, Option, Schema } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- readiness is an inherited launcher descriptor.
import { closeSync, writeSync } from "node:fs";
import { runStackHost, StackHostError } from "../src/StackHost.ts";

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

/**
 * A real owner entrypoint, identical to `internal/host-process.ts`, except it puts
 * `<gateDir>/bin` first on PATH so a test can interpose on the container engine commands the owner runs.
 */
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
  // oxlint-disable-next-line effecttsgo/process-env-in-effect -- the PATH shim must reach the child processes the owner spawns.
  process.env.PATH = `${gateDir}/bin:${process.env.PATH ?? ""}`;
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
