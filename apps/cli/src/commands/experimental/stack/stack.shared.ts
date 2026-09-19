import type { ServiceCreation } from "@supabase/stack/effect";
import { Context, Data, Effect, Layer, Option, Path } from "effect";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";
import { StackApi, stackApiLayer } from "../../../command-internal/stack-api.ts";

export { StackApi, stackApiLayer };

type StackId = string;
const isStackId = (id: string): boolean => /^[0-9a-f]{64}$/u.test(id);

/** The target selected by the CLI adapter for one stack command. */
export interface StackTarget {
  readonly projectRoot: string;
  readonly id?: StackId;
  readonly name?: string;
  readonly runtime?: "native" | "docker" | "podman";
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

export const validateStackId = (id: string): Effect.Effect<StackId, StackTargetError> =>
  isStackId(id)
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

/** Resolves an existing stack by its persisted canonical package identity. */
export const stackTargetResolverLayer = Layer.effect(
  StackTargetResolver,
  Effect.gen(function* () {
    const settings = yield* CommandSettings;
    const stackApi = yield* StackApi;
    const path = yield* Path.Path;
    const resolve = Effect.fn("StackTargetResolver.resolve")(function* (input: {
      readonly projectRoot: string;
      readonly name?: string;
      readonly id?: string;
      readonly runtime: "auto" | "docker" | "native";
    }) {
      const id = input.id === undefined ? undefined : yield* validateStackId(input.id);
      const requestedRuntime = runtimeForFlag(input.runtime);
      const identity =
        id === undefined
          ? yield* stackApi
              .resolveIdentity({
                projectRoot: input.projectRoot,
                ...(input.name === undefined ? {} : { name: input.name }),
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new StackTargetError({
                      message: cause.message,
                      reason: "invalid-config",
                      cause,
                    }),
                ),
              )
          : undefined;
      const discovered = yield* stackApi
        .discover({ stateRoot: path.join(settings.supabaseHome, "stacks") })
        .pipe(
          Effect.mapError(
            (cause) =>
              new StackTargetError({
                message: cause.message,
                reason: "invalid-config",
                cause,
              }),
          ),
        );
      const found =
        id === undefined
          ? discovered.find(
              ({ definition }) =>
                identity !== undefined &&
                definition.identity.projectRoot === identity.projectRoot &&
                definition.identity.branchContext === identity.branchContext &&
                definition.identity.stackName === identity.stackName,
            )
          : discovered.find(({ definition }) => definition.id === id);
      if (id !== undefined && found === undefined)
        return yield* new StackTargetError({
          message: `Stack ${id} was not found`,
          reason: "flags",
        });
      if (found !== undefined && !runtimeMatches(found.definition.runtime, requestedRuntime))
        return yield* new StackTargetError({
          message: "The requested runtime does not match the existing stack",
          reason: "flags",
        });
      return {
        projectRoot:
          found?.definition.identity.projectRoot ?? identity?.projectRoot ?? input.projectRoot,
        ...(found === undefined ? {} : { id: found.definition.id }),
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(found === undefined && requestedRuntime === undefined
          ? {}
          : found === undefined
            ? { runtime: requestedRuntime }
            : { runtime: found.definition.runtime }),
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
