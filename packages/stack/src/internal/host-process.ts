import { Cause, Duration, Effect, Exit, identity, Option, Schema } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- readiness is an inherited launcher descriptor, and the startup payload file predates any service layer.
import { closeSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { HostStartupPayload } from "../HostProcess.ts";
import {
  RegistrationCheckInterval,
  runStackHost,
  StackHostError,
  type StackHostOptions,
} from "../StackHost.ts";

interface HostProcessOverrides extends Pick<StackHostOptions, "release"> {
  readonly registrationCheckInterval?: Duration.Input;
}

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
): Effect.Effect<StackHostOptions, StackHostError> =>
  Effect.gen(function* () {
    const [stateRoot, cacheRoot, stackId, payloadFile, ...rest] = args;
    if (
      stateRoot === undefined ||
      cacheRoot === undefined ||
      stackId === undefined ||
      rest.length > 0
    )
      return yield* new StackHostError({
        operation: "startup",
        message: "Expected stateRoot, cacheRoot, stackId and an optional startup payload file",
      });
    // The file is deleted as soon as it is read so its secrets never outlive startup on disk.
    const payload: HostStartupPayload | undefined =
      payloadFile === undefined || payloadFile === ""
        ? undefined
        : yield* Effect.gen(function* () {
            const text = yield* Effect.try({
              try: () => readFileSync(payloadFile, "utf8"),
              catch: (cause) =>
                new StackHostError({ operation: "startup", message: String(cause) }),
            });
            return yield* Schema.decodeEffect(Schema.fromJsonString(HostStartupPayload))(text).pipe(
              Effect.mapError(
                (cause) => new StackHostError({ operation: "startup", message: cause.message }),
              ),
            );
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                try {
                  unlinkSync(payloadFile);
                } catch {
                  // The launcher may already have removed it.
                }
              }),
            ),
          );
    return {
      stateRoot,
      cacheRoot,
      stackId,
      ...(payload?.register === undefined ? {} : { register: payload.register }),
      ...(payload?.requestedCreations === undefined
        ? {}
        : { requestedCreations: payload.requestedCreations }),
      onReady: ({ endpoint, secret }) => report({ type: "ready", endpoint, secret }),
    };
  });

const program = (
  args: ReadonlyArray<string>,
  { registrationCheckInterval, ...overrides }: HostProcessOverrides,
) =>
  Effect.gen(function* () {
    let reported = false;
    const report = (value: unknown) =>
      Effect.suspend(() => {
        if (reported) return Effect.void;
        reported = true;
        return writeLine(value);
      });
    const host = yield* options(args, report);
    yield* runStackHost({ ...host, ...overrides }).pipe(
      Effect.catchCause((cause) => {
        const failure = Option.getOrUndefined(Cause.findErrorOption(cause));
        return report({
          type: "error",
          message: failure?.message ?? Cause.pretty(cause),
          ...(failure?.reason === undefined ? {} : { reason: failure.reason }),
        }).pipe(Effect.exit, Effect.andThen(Effect.failCause(cause)));
      }),
    );
  }).pipe(
    registrationCheckInterval === undefined
      ? identity
      : Effect.provideService(RegistrationCheckInterval, registrationCheckInterval),
  );

const flushed = (stream: NodeJS.WriteStream) =>
  Effect.callback<void>((resume) => {
    stream.write("", () => resume(Effect.void));
  }).pipe(Effect.timeoutOption("1 second"));

/**
 * Runs the owner process with its state root, artifact cache and stack identity, then exits the
 * process once shutdown cleanup completes and the owner log is flushed, so no leftover handle
 * delays the exit clients wait for.
 */
export const runHostProcess = (
  args: ReadonlyArray<string>,
  overrides: HostProcessOverrides = {},
): Promise<never> =>
  Effect.runPromise(
    program(args, overrides).pipe(
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

if (import.meta.main) void runHostProcess(process.argv.slice(2));
