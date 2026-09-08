import { Context, Data, Effect, FileSystem, Layer, Path, Crypto } from "effect";
import {
  createStack,
  inspectStack,
  isStackId,
  openStack,
  type StackRuntimePreference,
} from "@supabase/stack/effect";
import type { StackId } from "@supabase/stack";
import { StackNotFoundError } from "@supabase/stack/effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

/** The target selected by the CLI adapter for one experimental stack command. */
interface LegacyExperimentalStackTarget {
  readonly projectRoot: string;
  readonly id?: StackId;
  readonly name?: string;
  readonly runtime?: StackRuntimePreference;
}

export class LegacyExperimentalStackTargetError extends Data.TaggedError(
  "LegacyExperimentalStackTargetError",
)<{
  readonly message: string;
  readonly reason: "flags" | "invalid-config";
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.reason === "flags" ? actionability.provideFlags : actionability.invalidConfig;
  }
}

/**
 * Configuration and targeting are deliberately supplied by the CLI adapter.
 * Keeping this boundary independent of command handlers lets the later stack
 * commands reuse exactly the same project, name, id, and environment rules.
 */
interface LegacyExperimentalStackTargetResolverShape {
  readonly resolve: (input: {
    readonly projectRoot: string;
    readonly name?: string;
    readonly id?: string;
    readonly runtime: "auto" | "docker" | "native";
  }) => Effect.Effect<
    LegacyExperimentalStackTarget,
    LegacyExperimentalStackTargetError,
    FileSystem.FileSystem | Path.Path | Crypto.Crypto | LegacyExperimentalStackApi
  >;
}

export class LegacyExperimentalStackTargetResolver extends Context.Service<
  LegacyExperimentalStackTargetResolver,
  LegacyExperimentalStackTargetResolverShape
>()("supabase/experimental-stack/TargetResolver") {}

export class LegacyExperimentalStackApi extends Context.Service<
  LegacyExperimentalStackApi,
  {
    readonly createStack: typeof createStack;
    readonly openStack: typeof openStack;
    readonly inspectStack: typeof inspectStack;
  }
>()("supabase/experimental-stack/StackApi") {}

export const legacyExperimentalStackApiLayer = Layer.succeed(LegacyExperimentalStackApi, {
  createStack,
  openStack,
  inspectStack,
});

/** Runtime configuration for the first stack command. Later commands reuse this layer. */
export const legacyExperimentalStackTargetResolverLayer = Layer.succeed(
  LegacyExperimentalStackTargetResolver,
  {
    resolve: (input) =>
      Effect.gen(function* () {
        if (input.id !== undefined && !isStackId(input.id)) {
          return yield* new LegacyExperimentalStackTargetError({
            message: "--stack-id must be a lowercase SHA-256 stack id",
            reason: "flags",
          });
        }
        const id = input.id;
        const stackApi = yield* LegacyExperimentalStackApi;
        const inspection =
          id === undefined
            ? undefined
            : yield* stackApi.inspectStack(id).pipe(
                Effect.mapError(
                  (error) =>
                    new LegacyExperimentalStackTargetError({
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
          return yield* new LegacyExperimentalStackTargetError({
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
  },
);
