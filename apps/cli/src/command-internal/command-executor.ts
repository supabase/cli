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
import { failureBesideClosedStdout, ignoreStdoutClosed } from "../shared/output/errors.ts";
import { withJsonErrorHandling } from "../shared/output/json-error-handling.ts";
import { normalizeCliError } from "../shared/output/normalize-error.ts";
import { Output } from "../shared/output/output.service.ts";
import type { ProcessControl } from "../shared/runtime/process-control.service.ts";
import type { CommandRuntime } from "../shared/runtime/command-runtime.service.ts";
import type { Analytics } from "../shared/telemetry/analytics.service.ts";
import type { InvalidOutputFormatError } from "./output-formats.ts";
import { requireHostedMutationConsent } from "./hosted-consent/hosted-consent.ts";
import type { RemovedSurfaceError } from "./removed-command.ts";
import { withCommandTelemetry } from "../telemetry/command-telemetry.ts";
import { LinkedProjectCache } from "../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../telemetry/telemetry-state.service.ts";

interface CommandUXShape {
  readonly requireHostedMutationConsent: typeof requireHostedMutationConsent;
  readonly task: <A, E, R>(
    message: string,
    operation: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  /** Writes text unchanged in every format unless suppression is requested. */
  readonly writeToStderr: (
    text: string,
    options?: { readonly suppressInMachineMode?: boolean },
  ) => Effect.Effect<void>;
  /** Appends a newline in text mode and writes nothing in machine modes. */
  readonly writeToStdout: (message: string) => Effect.Effect<void>;
}

export class CommandUX extends Context.Service<CommandUX, CommandUXShape>()("supabase/CommandUX") {}

export class ResolvedProject extends Context.Service<
  ResolvedProject,
  {
    /** Record completed resolution; an absent ref still requests telemetry flush. */
    readonly record: (ref: string | undefined) => Effect.Effect<void>;
  }
>()("supabase/ResolvedProject") {}

interface ResultReadyContext {
  readonly ux: Pick<CommandUXShape, "writeToStdout">;
}

/**
 * Hooks let commands react to named events while the executor owns their order.
 * Add a hook when a command needs to act at a distinct point in its lifecycle,
 * for example after result delivery or when the invocation ends.
 */
interface ManagedHooks<A> {
  /**
   * Runs once in every output mode after the handler returns and required cleanup succeeds.
   * Failure or interruption before that point skips the hook.
   * The executor waits for the hook to succeed before encoding or writing a machine result.
   */
  readonly onResultReady?: (result: A, context: ResultReadyContext) => Effect.Effect<void>;
}

type ResultSchema = Schema.Codec<unknown, unknown>;
interface ManagedResult<S extends ResultSchema> {
  readonly output: S["Type"];
  readonly hookData?: unknown;
}

interface Declaration<Flags, S extends ResultSchema, A extends ManagedResult<S>, E, R> {
  readonly output: S;
  readonly hooks?: ManagedHooks<NoInfer<A>>;
  readonly handler: (flags: Flags) => Effect.Effect<A, E, R>;
}

interface LegacyDeclaration<Flags, E, R> {
  readonly output?: never;
  readonly hooks?: never;
  readonly handler: (flags: Flags) => Effect.Effect<unknown, E, R>;
}

type ExecutionDeclaration<Flags, S extends ResultSchema, A extends ManagedResult<S>, E, R> =
  | (Declaration<Flags, S, A, E, R> & { readonly owner: "executor" })
  | (LegacyDeclaration<Flags, E, R> & { readonly owner: "handler" });

type ExecutionServices =
  | Output
  | LinkedProjectCache
  | TelemetryState
  | Analytics
  | CommandRuntime
  | ProcessControl
  | Stdio.Stdio;

interface CommandExecutorShape {
  readonly run: <
    Flags extends Record<string, unknown>,
    S extends ResultSchema,
    A extends ManagedResult<S>,
    E,
    R,
    LA,
    LE,
    LR,
  >(
    declaration: ExecutionDeclaration<Flags, S, A, E, R>,
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
  requireHostedMutationConsent,
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
  writeToStderr: (text, options) =>
    options?.suppressInMachineMode && isMachine(output) ? Effect.void : output.raw(text, "stderr"),
  writeToStdout: (message) => (isMachine(output) ? Effect.void : output.raw(`${message}\n`)),
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
    const resolvedProject = yield* Ref.make(Option.none<string | undefined>());
    const ux = commandUX(output);
    const execute = <A, E, R>(handler: () => Effect.Effect<A, E, R>) =>
      Effect.suspend(handler).pipe(
        Effect.provideService(CommandUX, ux),
        Effect.provideService(ResolvedProject, {
          record: (ref) => Ref.set(resolvedProject, Option.some(ref)),
        }),
        Effect.scoped,
        Effect.provideContext(services),
      );
    const instrument = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
      operation.pipe(
        Effect.ensuring(
          Ref.get(resolvedProject).pipe(
            Effect.flatMap((project) => {
              if (Option.isNone(project)) return Effect.void;
              const ref = project.value;
              return (
                ref === undefined ? Effect.void : bestEffort(Effect.suspend(() => cache.cache(ref)))
              ).pipe(Effect.ensuring(bestEffort(Effect.suspend(() => telemetry.flush))));
            }),
          ),
        ),
        withCommandTelemetry({ flags }),
      );

    if (declaration.owner === "handler") {
      // Legacy writes do not mark a terminal attempt: the runner owns unhandled failures.
      return yield* instrument(execute(() => declaration.handler(flags))).pipe(
        withJsonErrorHandling,
        Scope.use(requiredScope),
        Effect.asVoid,
      );
    }

    const response = yield* TerminalResponse;
    const attempted = yield* Ref.make(false);
    const writeTerminal = (write: () => Effect.Effect<void>) =>
      Ref.set(attempted, true).pipe(
        Effect.andThen(response.markAttempt),
        Effect.andThen(Effect.suspend(write)),
        Effect.tapCause((cause) => {
          const remaining = failureBesideClosedStdout(cause);
          return remaining !== undefined && Cause.hasDies(remaining) && !Cause.hasInterrupts(cause)
            ? response.markWriterDefect
            : Effect.void;
        }),
      );

    const exit = yield* Effect.gen(function* () {
      // Keep handler finalizers inside the services' lifetime, and own release before delivery.
      const result = yield* execute(() => declaration.handler(flags)).pipe(
        Scope.use(requiredScope),
      );
      const onResultReady = declaration.hooks?.onResultReady;
      if (onResultReady) {
        yield* onResultReady(result, {
          ux: { writeToStdout: ux.writeToStdout },
        });
      }
      if (isMachine(output)) {
        const encoded = yield* Schema.encodeEffect(declaration.output)(result.output).pipe(
          Effect.orDie,
        );
        yield* writeTerminal(() => output.result(encoded));
      }
    }).pipe(instrument, Effect.exit);
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
        const report = normalizeCliError(typed.value);
        yield* ignoreStdoutClosed(writeTerminal(() => output.fail(report)));
      }
    }
    return yield* Effect.failCause(exit.cause);
  }).pipe(Effect.scoped);

export const commandExecutorLayer = Layer.succeed(CommandExecutor, { run });

interface ExecutionRuntime<LA, LE, LR, CA, CE, CR> {
  readonly required: Layer.Layer<LA, LE, LR>;
  readonly completion: Layer.Layer<CA, CE, CR>;
}

export const withManagedHandler = <
  Flags extends Record<string, unknown>,
  S extends ResultSchema,
  A extends ManagedResult<S>,
  E,
  R,
  LA,
  LE,
  LR,
  CA,
  CE,
  CR,
>(
  declaration: Declaration<Flags, S, A, E, R> & {
    readonly runtime: ExecutionRuntime<LA, LE, LR, CA, CE, CR>;
  },
) =>
  flow(
    Command.withHandler((flags: Flags) =>
      CommandExecutor.use((executor) =>
        executor.run({ ...declaration, owner: "executor" }, flags, declaration.runtime.required),
      ),
    ),
    Command.provide(declaration.runtime.completion),
  );

/** Run a handler that owns its output without delivering an executor result. */
export const withLegacyOutputHandler = <
  Flags extends Record<string, unknown>,
  E,
  R,
  LA,
  LE,
  LR,
  CA,
  CE,
  CR,
>(
  declaration: LegacyDeclaration<Flags, E, R> & {
    readonly runtime: ExecutionRuntime<LA, LE, LR, CA, CE, CR>;
  },
) =>
  flow(
    Command.withHandler((flags: Flags) =>
      CommandExecutor.use((executor) =>
        executor.run({ ...declaration, owner: "handler" }, flags, declaration.runtime.required),
      ),
    ),
    Command.provide(declaration.runtime.completion),
  );
