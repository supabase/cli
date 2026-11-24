import {
  Cause,
  Context,
  Effect,
  Exit,
  flow,
  Layer,
  Option,
  Ref,
  Schema,
  Scope,
  type Stdio,
} from "effect";
import { Command } from "effect/cli";

import { TerminalResponse } from "../shared/cli/terminal-response.service.ts";
import { ignoreStdoutClosed } from "../shared/output/errors.ts";
import { normalizeCliError } from "../shared/output/normalize-error.ts";
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

export class ResolvedProject extends Context.Service<
  ResolvedProject,
  {
    readonly record: (ref: string) => Effect.Effect<void>;
  }
>()("supabase/ResolvedProject") {}

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
  readonly run: <Flags extends Record<string, unknown>, S extends ResultSchema, E, R, LA, LE, LR>(
    declaration: Declaration<Flags, S, E, R>,
    flags: Flags,
    required: Layer.Layer<LA, LE, LR>,
  ) => Effect.Effect<
    void,
    E | LE | InvalidOutputFormatError | RemovedSurfaceError,
    | Exclude<Exclude<Exclude<Exclude<R, CommandUX>, ResolvedProject>, Scope.Scope>, LA>
    | LR
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
      : Effect.acquireUseRelease(
          output.task(message),
          () => operation,
          (task, exit) =>
            bestEffort(
              Effect.suspend(() =>
                Exit.isFailure(exit) &&
                Cause.hasFails(exit.cause) &&
                !Cause.hasDies(exit.cause) &&
                !Cause.hasInterrupts(exit.cause)
                  ? task.fail()
                  : task.clear,
              ),
            ),
        ),
  message: (message) => (isMachine(output) ? Effect.void : output.raw(`${message}\n`, "stderr")),
});

const bestEffort = (effect: Effect.Effect<void>) => effect.pipe(Effect.ignoreCause);

const run: CommandExecutorShape["run"] = (declaration, flags, required) =>
  Effect.gen(function* () {
    const requiredScope = yield* Scope.fork(yield* Scope.Scope);
    // Acquire before instrumentation, as with Command.provide. Do not borrow a memoized scope
    // that could retain a required layer past the delivery boundary.
    const services = yield* Layer.buildWithMemoMap(
      required,
      Layer.makeMemoMapUnsafe(),
      requiredScope,
    );
    const output = yield* Output;
    const cache = yield* LinkedProjectCache;
    const telemetry = yield* TelemetryState;
    const response = yield* TerminalResponse;
    const resolvedProjectRef = yield* Ref.make<string | undefined>(undefined);
    const attempted = yield* Ref.make(false);
    const beginWrite = Ref.set(attempted, true).pipe(Effect.andThen(response.markAttempt));

    const exit = yield* Effect.gen(function* () {
      // Keep handler finalizers inside the services' lifetime, and own release before delivery.
      const result = yield* Effect.suspend(() => declaration.handler(flags)).pipe(
        Effect.provideService(CommandUX, commandUX(output)),
        Effect.provideService(ResolvedProject, {
          record: (ref) => Ref.set(resolvedProjectRef, ref),
        }),
        Effect.scoped,
        Effect.provideContext(services),
        Scope.use(requiredScope),
      );
      if (isMachine(output)) {
        const encoded = yield* Schema.encodeEffect(declaration.output)(result).pipe(Effect.orDie);
        yield* beginWrite;
        yield* output.result(encoded);
      }
    }).pipe(
      Effect.ensuring(
        Ref.get(resolvedProjectRef).pipe(
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
    // Only typed machine errors need the command's output context. The runner reports other
    // failures after shutdown, so a signal during shutdown can still suppress their diagnostics.
    if (
      isMachine(output) &&
      !(yield* Ref.get(attempted)) &&
      !Cause.hasDies(exit.cause) &&
      !Cause.hasInterrupts(exit.cause)
    ) {
      const typed = Cause.findErrorOption(exit.cause);
      if (Option.isSome(typed)) {
        yield* beginWrite.pipe(
          Effect.andThen(
            ignoreStdoutClosed(Effect.suspend(() => output.fail(normalizeCliError(typed.value)))),
          ),
        );
      }
    }
    return yield* Effect.failCause(exit.cause);
  }).pipe(Effect.scoped);

export const commandExecutorLayer = Layer.succeed(CommandExecutor, { run });

export const withManagedHandler = <
  Flags extends Record<string, unknown>,
  S extends ResultSchema,
  E,
  R,
  LA,
  LE,
  LR,
  CA,
  CE,
  CR,
>(
  declaration: Declaration<Flags, S, E, R> & {
    readonly runtime: {
      readonly required: Layer.Layer<LA, LE, LR>;
      readonly completion: Layer.Layer<CA, CE, CR>;
    };
  },
) =>
  flow(
    Command.withHandler((flags: Flags) =>
      CommandExecutor.use((executor) =>
        executor.run(declaration, flags, declaration.runtime.required),
      ),
    ),
    Command.provide(declaration.runtime.completion),
  );
