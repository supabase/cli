import {
  Context,
  Data,
  Effect,
  type Exit,
  type FileSystem,
  Layer,
  Option,
  type Path,
} from "effect";
import { extractCommandPath, hasRootVersionFlag } from "../shared/cli/run.ts";
import type { ExperimentalFeatureFlagError } from "./experimental-feature.ts";
import {
  projectStateMode,
  type ProjectStateMode,
  softProjectStateMode,
} from "./project-state-mode.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";

export type StackBackend = "legacy" | "stack";

/** Commands that consult experimental.stack for local database, shadow, and storage routing. */
const STACK_BACKEND_COMMANDS = new Set([
  "start",
  "stop",
  "status",
  "db",
  "migration",
  "test",
  "gen",
  "inspect",
  "pull",
  "storage",
  "seed",
  "services",
]);

export const isFunctionsServePath = (path: ReadonlyArray<string>): boolean =>
  path[0] === "functions" && path[1] === "serve";

export class StackRoutingError extends Data.TaggedError("StackRoutingError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {
  get suggestion(): string {
    return "Set SUPABASE_EXPERIMENTAL_STACK=1 to enable stack commands, or 0 to use legacy start/stop/status.";
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/** In-process backend selected before parse; handlers must not re-read argv. */
export class StackBackendContext extends Context.Service<
  StackBackendContext,
  { readonly kind: StackBackend }
>()("supabase/stack/Backend") {}

export const stackBackendLayer = (kind: StackBackend) =>
  Layer.succeed(StackBackendContext, { kind });

/** Handlers default to legacy when no backend was routed for the command. */
export const currentStackBackend: Effect.Effect<{ readonly kind: StackBackend }, never, never> =
  Effect.serviceOption(StackBackendContext).pipe(
    Effect.map((value) => Option.getOrElse(value, () => ({ kind: "legacy" as const }))),
  );

/**
 * Whether this command keeps project state in `$SUPABASE_HOME` instead of `supabase/.temp`: it was
 * routed to the stack backend, or the project is in stack state mode (commands that are never
 * routed, such as `functions deploy`).
 */
export const usesStackState: Effect.Effect<boolean> = Effect.gen(function* () {
  if ((yield* currentStackBackend).kind === "stack") return true;
  return (yield* softProjectStateMode) === "stack";
});

/**
 * Resolves the project state mode and, for the commands `experimental.stack` routes, the backend.
 * Routed commands fail on an invalid `SUPABASE_EXPERIMENTAL_STACK`; for the others the failure
 * stays in `projectState` for the readers that need it. Both are `undefined` for `--version`.
 */
export const resolveProjectStateSelection = Effect.fn("ProjectState.resolveSelection")(
  function* (input: {
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
  }): Effect.fn.Return<
    {
      readonly projectState: Exit.Exit<ProjectStateMode, ExperimentalFeatureFlagError> | undefined;
      readonly stackBackend: StackBackend | undefined;
    },
    StackRoutingError,
    FileSystem.FileSystem | Path.Path
  > {
    // Completion passes the final token as the cursor word, so it is not part of
    // the resolved command path.
    const routingArgs =
      input.args[0] === "__complete" || input.args[0] === "__completeNoDesc"
        ? input.args.slice(0, -1)
        : input.args;
    if (hasRootVersionFlag(routingArgs))
      return { projectState: undefined, stackBackend: undefined };

    const commandPath = extractCommandPath(routingArgs);
    const completePath =
      commandPath[0] === "__complete" || commandPath[0] === "__completeNoDesc"
        ? commandPath.slice(1)
        : commandPath;
    const routedPath = completePath[0] === "help" ? completePath.slice(1) : completePath;
    const command = routedPath[0];
    const routed =
      command === undefined ||
      command === "stack" ||
      STACK_BACKEND_COMMANDS.has(command) ||
      isFunctionsServePath(routedPath);

    const projectState = yield* Effect.exit(projectStateMode({ ...input, args: routingArgs }));
    const stackBackend = routed
      ? yield* projectState.pipe(
          Effect.mapError(
            (error) => new StackRoutingError({ message: error.message, cause: error }),
          ),
        )
      : undefined;
    return { projectState, stackBackend };
  },
);
