import { Cause, Effect, Exit, Option, Schema } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- readiness is an inherited launcher descriptor.
import { closeSync, writeSync } from "node:fs";
import { SavedStack } from "../src/StackNamespace.ts";
import { RegistrationCheckInterval, runStackHost, StackHostError } from "../src/StackHost.ts";

/**
 * A real owner entrypoint, identical to `internal/host-process.ts`, except it overrides the
 * registration-loss poll interval (F6) through the sanctioned internal `Context.Reference` so an
 * abandonment test does not wait a real 30 seconds. Production code never reads this from an
 * environment variable or `Config`; only this dedicated test fixture supplies a different value.
 */
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

const [stateRoot, cacheRoot, stackId, register, ...rest] = process.argv.slice(2);

const program = Effect.gen(function* () {
  if (
    stateRoot === undefined ||
    cacheRoot === undefined ||
    stackId === undefined ||
    rest.length > 0
  )
    return yield* new StackHostError({
      operation: "startup",
      message: "Expected stateRoot, cacheRoot, stackId and an optional stack to register",
    });
  const registered =
    register === undefined
      ? undefined
      : yield* Schema.decodeEffect(Schema.fromJsonString(SavedStack))(register).pipe(
          Effect.mapError(
            (cause) => new StackHostError({ operation: "startup", message: cause.message }),
          ),
        );
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
    ...(registered === undefined ? {} : { register: registered }),
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
}).pipe(Effect.provideService(RegistrationCheckInterval, "200 millis"));

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
