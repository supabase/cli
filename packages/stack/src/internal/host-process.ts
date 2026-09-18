import { Cause, Effect, Option, Schema } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- readiness is an inherited launcher descriptor.
import { closeSync, writeSync } from "node:fs";
import { runStackHost, StackHostError, type StackHostOptions } from "../StackHost.ts";

const causeCode = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause === null) return undefined;
  if ("code" in cause && typeof cause.code === "string") return cause.code;
  if ("cause" in cause) return causeCode(cause.cause);
  return undefined;
};

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

const options = (): Effect.Effect<StackHostOptions, StackHostError> => {
  const args = process.argv.slice(2);
  if (args.length !== 3)
    return Effect.fail(
      new StackHostError({
        operation: "startup",
        message: "Expected stateRoot, cacheRoot and stackId",
      }),
    );
  const stateRoot = args[0];
  const cacheRoot = args[1];
  const stackId = args[2];
  if (stateRoot === undefined || cacheRoot === undefined || stackId === undefined)
    return Effect.fail(
      new StackHostError({ operation: "startup", message: "Missing host argument" }),
    );
  return Effect.succeed({
    stateRoot,
    cacheRoot,
    stackId,
    onReady: (endpoint) => writeLine({ type: "ready", endpoint }),
  });
};

const program = Effect.gen(function* () {
  const host = yield* options();
  yield* runStackHost(host).pipe(
    Effect.catchCause((cause) => {
      const failure = Option.getOrUndefined(Cause.findErrorOption(cause));
      const reason = causeCode(failure?.cause) === "EADDRINUSE" ? "bind-conflict" : undefined;
      return writeLine({
        type: "error",
        message: String(cause),
        ...(reason === undefined ? {} : { reason }),
      }).pipe(Effect.andThen(Effect.failCause(cause)));
    }),
  );
});

Effect.runPromise(program).catch(() => {
  process.exitCode = 1;
});
