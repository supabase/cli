import {
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  Ref,
  Schema,
  type Scope,
  type Stdio,
} from "effect";
import { Command } from "effect/cli";

import { TerminalResponse } from "../shared/cli/terminal-response.service.ts";
import { failureBesideClosedStdout } from "../shared/output/errors.ts";
import { normalizeCause, normalizeCliError } from "../shared/output/normalize-error.ts";
import { Output } from "../shared/output/output.service.ts";
import type { ProcessControl } from "../shared/runtime/process-control.service.ts";
import type { CommandRuntime } from "../shared/runtime/command-runtime.service.ts";
import type { Analytics } from "../shared/telemetry/analytics.service.ts";
import type { InvalidOutputFormatError } from "./output-formats.ts";
import type { RemovedSurfaceError } from "./removed-command.ts";
import { withCommandTelemetry } from "../telemetry/command-telemetry.ts";
import { LinkedProjectCache } from "../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../telemetry/telemetry-state.service.ts";

interface CommandUXShape {
  readonly task: <A, E, R>(
    message: string,
    operation: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly message: (message: string) => Effect.Effect<void>;
}

export class CommandUX extends Context.Service<CommandUX, CommandUXShape>()("supabase/CommandUX") {}

export class PendingProjectCacheFill extends Context.Service<
  PendingProjectCacheFill,
  {
    readonly request: (ref: string) => Effect.Effect<void>;
  }
>()("supabase/PendingProjectCacheFill") {}

type ResultSchema = Schema.Codec<unknown, unknown>;
interface Declaration<Flags, S extends ResultSchema, E, R> {
  readonly output: S;
  readonly handler: (flags: Flags) => Effect.Effect<NoInfer<S["Type"]>, E, R>;
}

type ExecutionServices =
  | Output
  | LinkedProjectCache
  | TelemetryState
  | Analytics
  | CommandRuntime
  | ProcessControl
  | Stdio.Stdio;

interface CommandExecutorShape {
  readonly run: <Flags extends Record<string, unknown>, S extends ResultSchema, E, R>(
    declaration: Declaration<Flags, S, E, R>,
    flags: Flags,
  ) => Effect.Effect<
    void,
    E | InvalidOutputFormatError | RemovedSurfaceError,
    | Exclude<Exclude<Exclude<R, CommandUX>, PendingProjectCacheFill>, Scope.Scope>
    | ExecutionServices
  >;
}

export class CommandExecutor extends Context.Service<CommandExecutor, CommandExecutorShape>()(
  "supabase/CommandExecutor",
) {}

const isMachine = (output: Output["Service"]) => output.format !== "text";

// TODO(CLI-3186): Share stderr and task primitives with Output. Until then, delegate to
// Output so messages pause the same spinner that legacy commands use.
const commandUX = (output: Output["Service"]): CommandUXShape => ({
  task: (message, operation) =>
    isMachine(output)
      ? operation
      : Effect.gen(function* () {
          const task = yield* output.task(message);
          const result = yield* operation.pipe(Effect.tapError(() => task.fail()));
          yield* task.clear;
          return result;
        }),
  message: (message) => (isMachine(output) ? Effect.void : output.raw(`${message}\n`, "stderr")),
});

const bestEffort = (effect: Effect.Effect<void>) => effect.pipe(Effect.ignoreCause);

const run: CommandExecutorShape["run"] = (declaration, flags) =>
  Effect.gen(function* () {
    const output = yield* Output;
    const cache = yield* LinkedProjectCache;
    const telemetry = yield* TelemetryState;
    const response = yield* TerminalResponse;
    const target = yield* Ref.make<string | undefined>(undefined);
    const attempted = yield* Ref.make(false);
    const beginWrite = Ref.set(attempted, true).pipe(Effect.andThen(response.markAttempt));

    const exit = yield* Effect.gen(function* () {
      const result = yield* Effect.scoped(
        Effect.suspend(() => declaration.handler(flags)).pipe(
          Effect.provideService(CommandUX, commandUX(output)),
          Effect.provideService(PendingProjectCacheFill, {
            request: (ref) => Ref.set(target, ref),
          }),
        ),
      );
      if (isMachine(output)) {
        const encoded = yield* Schema.encodeEffect(declaration.output)(result).pipe(Effect.orDie);
        yield* beginWrite;
        yield* output.result(encoded);
      }
    }).pipe(
      Effect.ensuring(
        Ref.get(target).pipe(
          Effect.flatMap((ref) =>
            ref === undefined
              ? Effect.void
              : bestEffort(Effect.suspend(() => cache.cache(ref))).pipe(
                  Effect.ensuring(bestEffort(telemetry.flush)),
                ),
          ),
        ),
      ),
      withCommandTelemetry({ flags }),
      Effect.exit,
    );
    if (Exit.isSuccess(exit)) return;
    const cause = failureBesideClosedStdout(exit.cause);
    if (!(yield* Ref.get(attempted)) && cause !== undefined && !Cause.hasInterruptsOnly(cause)) {
      const typed =
        !Cause.hasDies(cause) && !Cause.hasInterrupts(cause)
          ? Cause.findErrorOption(cause)
          : Option.none();
      const report = Effect.suspend(() =>
        isMachine(output) && Option.isSome(typed)
          ? output.fail(normalizeCliError(typed.value))
          : (response.reportFailure?.(cause) ?? output.fail(normalizeCause(cause))),
      );
      yield* beginWrite.pipe(Effect.andThen(bestEffort(report)));
    }
    return yield* Effect.failCause(exit.cause);
  });

export const commandExecutorLayer = Layer.succeed(CommandExecutor, { run });

export const withManagedHandler = <
  Flags extends Record<string, unknown>,
  S extends ResultSchema,
  E,
  R,
>(
  declaration: Declaration<Flags, S, E, R>,
) =>
  Command.withHandler((flags: Flags) =>
    CommandExecutor.use((executor) => executor.run(declaration, flags)),
  );
