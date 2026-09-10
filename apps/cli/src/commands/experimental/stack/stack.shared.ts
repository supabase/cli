import { Context, Data, Effect, FileSystem, Layer, Option, Path, Crypto } from "effect";
import {
  createStack,
  findStack,
  inspectStack,
  isStackId,
  openStack,
  type StackRuntimePreference,
} from "@supabase/stack/effect";
import type { StackId } from "@supabase/stack";
import { StackNotFoundError } from "@supabase/stack/effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

/** The target selected by the CLI adapter for one experimental stack command. */
interface ExperimentalStackTarget {
  readonly projectRoot: string;
  readonly id?: StackId;
  readonly name?: string;
  readonly runtime?: StackRuntimePreference;
}

export class ExperimentalStackTargetError extends Data.TaggedError("ExperimentalStackTargetError")<{
  readonly message: string;
  readonly reason: "flags" | "invalid-config";
  readonly suggestion?: string;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.reason === "flags" ? actionability.provideFlags : actionability.invalidConfig;
  }
}

/**
 * Configuration and targeting are supplied by the CLI adapter so later stack
 * commands can reuse the same project, name, id, and environment rules.
 */
interface ExperimentalStackTargetResolverShape {
  readonly resolve: (input: {
    readonly projectRoot: string;
    readonly name?: string;
    readonly id?: string;
    readonly runtime: "auto" | "docker" | "native";
  }) => Effect.Effect<ExperimentalStackTarget, ExperimentalStackTargetError, ExperimentalStackApi>;
}

export class ExperimentalStackTargetResolver extends Context.Service<
  ExperimentalStackTargetResolver,
  ExperimentalStackTargetResolverShape
>()("supabase/experimental-stack/TargetResolver") {}

export class ExperimentalStackApi extends Context.Service<
  ExperimentalStackApi,
  {
    readonly findStack: (
      ...args: Parameters<typeof findStack>
    ) => Effect.Effect<
      Effect.Success<ReturnType<typeof findStack>>,
      Effect.Error<ReturnType<typeof findStack>>
    >;
    readonly createStack: (
      ...args: Parameters<typeof createStack>
    ) => Effect.Effect<
      Effect.Success<ReturnType<typeof createStack>>,
      Effect.Error<ReturnType<typeof createStack>>
    >;
    readonly openStack: (
      ...args: Parameters<typeof openStack>
    ) => Effect.Effect<
      Effect.Success<ReturnType<typeof openStack>>,
      Effect.Error<ReturnType<typeof openStack>>
    >;
    readonly inspectStack: (
      ...args: Parameters<typeof inspectStack>
    ) => Effect.Effect<
      Effect.Success<ReturnType<typeof inspectStack>>,
      Effect.Error<ReturnType<typeof inspectStack>>
    >;
  }
>()("supabase/experimental-stack/StackApi") {}

export const validateExperimentalStackTarget = (input: {
  readonly stack?: string;
  readonly stackId?: string;
}): Effect.Effect<void, ExperimentalStackTargetError> =>
  Effect.gen(function* () {
    if (input.stack !== undefined && input.stackId !== undefined) {
      return yield* new ExperimentalStackTargetError({
        message: "--stack and --stack-id cannot be used together",
        reason: "flags",
      });
    }
  });

export const validateExperimentalStackId = (
  id: string,
): Effect.Effect<StackId, ExperimentalStackTargetError> =>
  isStackId(id)
    ? Effect.succeed(id)
    : Effect.fail(
        new ExperimentalStackTargetError({
          message: "--stack-id must be a lowercase SHA-256 stack id",
          reason: "flags",
        }),
      );

export const rejectExperimentalStackOutput = (
  outputFlag: Option.Option<Option.Option<string>>,
): Effect.Effect<void, ExperimentalStackTargetError> =>
  Option.isSome(outputFlag) && Option.isSome(outputFlag.value)
    ? Effect.fail(
        new ExperimentalStackTargetError({
          message: "The legacy -o/--output flag is not supported here; use --output-format json.",
          reason: "flags",
          suggestion:
            "Use --output-format json, --output-format text, or --output-format stream-json.",
        }),
      )
    : Effect.void;

export const experimentalStackApiLayer = Layer.effect(
  ExperimentalStackApi,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const childProcess = yield* ChildProcessSpawner.ChildProcessSpawner;
    const provideServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcess),
      );
    return {
      findStack: (...args: Parameters<typeof findStack>) => provideServices(findStack(...args)),
      createStack: (...args: Parameters<typeof createStack>) =>
        provideServices(createStack(...args)),
      openStack: (...args: Parameters<typeof openStack>) => provideServices(openStack(...args)),
      inspectStack: (...args: Parameters<typeof inspectStack>) =>
        provideServices(inspectStack(...args)),
    };
  }),
);

/** Runtime configuration for the first stack command. Later commands reuse this layer. */
export const experimentalStackTargetResolverLayer = Layer.succeed(ExperimentalStackTargetResolver, {
  resolve: (input) =>
    Effect.gen(function* () {
      const id = input.id === undefined ? undefined : yield* validateExperimentalStackId(input.id);
      const stackApi = yield* ExperimentalStackApi;
      const inspection =
        id === undefined
          ? undefined
          : yield* stackApi.inspectStack(id).pipe(
              Effect.mapError(
                (error) =>
                  new ExperimentalStackTargetError({
                    message: `Unable to inspect stack ${id}: ${error.message}`,
                    reason: error instanceof StackNotFoundError ? "flags" : "invalid-config",
                    cause: error,
                  }),
              ),
            );
      const projectRoot = inspection?.descriptor.projectRoot ?? input.projectRoot;
      const requestedRuntime =
        input.runtime === "auto"
          ? undefined
          : input.runtime === "native"
            ? { kind: "native" as const }
            : { kind: "container" as const, engine: "docker" as const };
      if (
        inspection !== undefined &&
        requestedRuntime !== undefined &&
        (inspection.descriptor.runtime.kind !== requestedRuntime.kind ||
          (requestedRuntime.kind === "container" &&
            inspection.descriptor.runtime.kind === "container" &&
            inspection.descriptor.runtime.engine !== requestedRuntime.engine))
      ) {
        return yield* new ExperimentalStackTargetError({
          message: "The requested runtime does not match the existing stack",
          reason: "flags",
        });
      }
      return {
        projectRoot,
        ...(id === undefined ? {} : { id }),
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(id === undefined && requestedRuntime !== undefined
          ? { runtime: requestedRuntime }
          : {}),
      };
    }),
});
