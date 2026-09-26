import {
  StackId,
  type SavedStack,
  type ServiceCreation,
  type StackError,
} from "@supabase/stack/effect";
import { Context, Data, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";
import {
  skippedRuntimeCleanupWarning,
  StackApi,
  stackApiLayer,
} from "../../../command-internal/stack-api.ts";

export { skippedRuntimeCleanupWarning, StackApi, stackApiLayer };

/** The target selected by the CLI adapter for one stack command. */
export interface StackTarget {
  readonly projectRoot: string;
  readonly id?: string;
  readonly name?: string;
  readonly runtime?: "native" | "docker" | "podman";
  readonly definition?: SavedStack;
  readonly hostRunning: boolean;
}

export class StackTargetError extends Data.TaggedError("ExperimentalStackTargetError")<{
  readonly message: string;
  readonly reason: "flags" | "invalid-config";
  readonly suggestion?: string;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.reason === "flags" ? actionability.provideFlags : actionability.invalidConfig;
  }
}

interface StackTargetResolverShape {
  readonly resolve: (input: {
    readonly projectRoot: string;
    readonly name?: string;
    readonly id?: string;
    readonly runtime: "auto" | "docker" | "native";
  }) => Effect.Effect<StackTarget, StackTargetError>;
}

export class StackTargetResolver extends Context.Service<
  StackTargetResolver,
  StackTargetResolverShape
>()("supabase/experimental-stack/TargetResolver") {}

export const validateStackTarget = (input: {
  readonly stack?: string;
  readonly stackId?: string;
}): Effect.Effect<void, StackTargetError> =>
  input.stack !== undefined && input.stackId !== undefined
    ? Effect.fail(
        new StackTargetError({
          message: "--stack and --stack-id cannot be used together",
          reason: "flags",
        }),
      )
    : Effect.void;

const validateStackId = (id: string): Effect.Effect<string, StackTargetError> =>
  Schema.is(StackId)(id)
    ? Effect.succeed(id)
    : Effect.fail(
        new StackTargetError({
          message: "--stack-id must be a lowercase SHA-256 stack id",
          reason: "flags",
        }),
      );

export const rejectStackOutput = (
  outputFlag: Option.Option<Option.Option<string>>,
): Effect.Effect<void, StackTargetError> =>
  Option.isSome(outputFlag) && Option.isSome(outputFlag.value)
    ? Effect.fail(
        new StackTargetError({
          message: "The legacy -o/--output flag is not supported here; use --output-format json.",
          reason: "flags",
          suggestion:
            "Use --output-format json, --output-format text, or --output-format stream-json.",
        }),
      )
    : Effect.void;

const runtimeForFlag = (
  runtime: "auto" | "docker" | "native",
): StackTarget["runtime"] | undefined =>
  runtime === "auto" ? undefined : runtime === "docker" ? "docker" : "native";

const runtimeMatches = (
  saved: StackTarget["runtime"],
  requested: StackTarget["runtime"],
): boolean => requested === undefined || saved === requested;

/** Resolves an existing stack by id or by the package identity of the project and stack name. */
export const stackTargetResolverLayer = Layer.effect(
  StackTargetResolver,
  Effect.gen(function* () {
    const settings = yield* CommandSettings;
    const stackApi = yield* StackApi;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resolve = Effect.fn("StackTargetResolver.resolve")(function* (input: {
      readonly projectRoot: string;
      readonly name?: string;
      readonly id?: string;
      readonly runtime: "auto" | "docker" | "native";
    }) {
      const id = input.id === undefined ? undefined : yield* validateStackId(input.id);
      const requestedRuntime = runtimeForFlag(input.runtime);
      const stateRoot = path.join(settings.supabaseHome, "stacks");
      const found = yield* stackApi
        .find(
          id === undefined
            ? {
                stateRoot,
                projectRoot: input.projectRoot,
                ...(input.name === undefined ? {} : { name: input.name }),
              }
            : { stateRoot, id },
        )
        .pipe(
          Effect.map(Option.getOrUndefined),
          Effect.mapError(
            (cause) =>
              new StackTargetError({
                message: cause.message,
                reason: "invalid-config",
                cause,
              }),
          ),
        );
      if (id !== undefined && found === undefined)
        return yield* new StackTargetError({
          message: `Stack ${id} was not found`,
          reason: "flags",
        });
      if (found !== undefined && !runtimeMatches(found.definition.runtime, requestedRuntime))
        return yield* new StackTargetError({
          message: `Requested runtime ${requestedRuntime} does not match existing stack runtime ${found.definition.runtime}`,
          suggestion:
            "Use --runtime auto to reuse the saved runtime, or omit --stack-id and choose a different --stack name.",
          reason: "flags",
        });
      const runtime = found?.definition.runtime ?? requestedRuntime;
      // A new stack saves paths under the canonical root its identity derives from.
      const projectRoot =
        found?.definition.identity.projectRoot ??
        (yield* fs
          .realPath(input.projectRoot)
          .pipe(
            Effect.mapError(
              (cause) =>
                new StackTargetError({ message: cause.message, reason: "invalid-config", cause }),
            ),
          ));
      return {
        projectRoot,
        ...(found === undefined ? {} : { id: found.definition.id, definition: found.definition }),
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(runtime === undefined ? {} : { runtime }),
        hostRunning: found?.host !== undefined,
      };
    });
    return StackTargetResolver.of({ resolve });
  }),
);

/** Groups companion services under their user-facing stack capability. */
export const stackCapabilityForService = (service: ServiceCreation["service"]) => {
  switch (service) {
    case "imgproxy":
      return "storage";
    case "vector":
      return "analytics";
    case "pgmeta":
      return "studio";
    default:
      return service;
  }
};

/** Formats the failed per-service outcomes of a composition error, one `label: error` per line. */
export const failedOutcomesDetail = (
  cause: Partial<Pick<StackError, "outcomes">>,
  label: (id: string) => string = (id) => id,
): string | undefined => {
  const failed = cause.outcomes?.filter((outcome) => !outcome.succeeded) ?? [];
  return failed.length === 0
    ? undefined
    : failed.map((outcome) => `${label(outcome.id)}: ${outcome.error ?? "failed"}`).join("\n");
};
