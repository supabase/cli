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

const options = (
  args: ReadonlyArray<string>,
  report: (value: unknown) => Effect.Effect<void, StackHostError>,
): Effect.Effect<StackHostOptions, StackHostError> => {
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
    onReady: (endpoint) => report({ type: "ready", endpoint }),
  });
};

const program = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    let reported = false;
    const report = (value: unknown) =>
      Effect.suspend(() => {
        if (reported) return Effect.void;
        reported = true;
        return writeLine(value);
      });
    const host = yield* options(args, report);
    yield* runStackHost(host).pipe(
      Effect.catchCause((cause) => {
        const failure = Option.getOrUndefined(Cause.findErrorOption(cause));
        const reason = causeCode(failure?.cause) === "EADDRINUSE" ? "bind-conflict" : undefined;
        return report({
          type: "error",
          message: String(cause),
          ...(reason === undefined ? {} : { reason }),
        }).pipe(Effect.exit, Effect.andThen(Effect.failCause(cause)));
      }),
    );
  });

/** Runs the owner process with its state root, artifact cache and stack identity. */
export const runHostProcess = (args: ReadonlyArray<string>): Promise<void> =>
  Effect.runPromise(program(args));

if (import.meta.main) {
  void runHostProcess(process.argv.slice(2)).catch(() => {
    process.exitCode = 1;
  });
}
