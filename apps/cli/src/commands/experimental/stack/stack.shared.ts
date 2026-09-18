import { Context, Data, Effect, Layer, Option } from "effect";
import {
  isStackId,
  StackNotFoundError,
  type StackRuntimePreference,
  type StackStatus,
} from "@supabase/stack/effect";
import type { StackId } from "@supabase/stack";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";
import { StackApi, stackApiLayer } from "../../../command-internal/stack-api.ts";

export { StackApi, stackApiLayer };

/** The target selected by the CLI adapter for one stack command. */
interface StackTarget {
  readonly projectRoot: string;
  readonly id?: StackId;
  readonly name?: string;
  readonly runtime?: StackRuntimePreference;
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

/**
 * Configuration and targeting are supplied by the CLI adapter so later stack
 * commands can reuse the same project, name, id, and environment rules.
 */
interface StackTargetResolverShape {
  readonly resolve: (input: {
    readonly projectRoot: string;
    readonly name?: string;
    readonly id?: string;
    readonly runtime: "auto" | "docker" | "native";
  }) => Effect.Effect<StackTarget, StackTargetError, StackApi>;
}

export class StackTargetResolver extends Context.Service<
  StackTargetResolver,
  StackTargetResolverShape
>()("supabase/experimental-stack/TargetResolver") {}

export const validateStackTarget = (input: {
  readonly stack?: string;
  readonly stackId?: string;
}): Effect.Effect<void, StackTargetError> =>
  Effect.gen(function* () {
    if (input.stack !== undefined && input.stackId !== undefined) {
      return yield* new StackTargetError({
        message: "--stack and --stack-id cannot be used together",
        reason: "flags",
      });
    }
  });

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

export const stackStatusPayload = (status: StackStatus) => ({
  id: status.id,
  lifecycle: status.lifecycle,
  desired_lifecycle: status.desiredLifecycle,
  runtime: status.runtime,
  endpoints: status.endpoints,
  versions: status.versions,
  capabilities: status.capabilities,
  artifacts: status.artifacts,
  ...(status.recovery === undefined ? {} : { recovery: status.recovery }),
});

export const stackStatusIssueLines = (status: StackStatus): ReadonlyArray<string> => {
  const lines: Array<string> = [];
  const diagnostics = status.capabilities.filter(({ error }) => error !== undefined);
  if (diagnostics.length > 0) {
    lines.push("Capability diagnostics:");
    for (const capability of diagnostics) {
      const detail = capability.error?.split(/\r?\n/u)[0] ?? "No diagnostic was recorded.";
      lines.push(`  ${capability.name}: ${capability.state} — ${detail}`);
    }
  }
  if (status.recovery !== undefined) {
    lines.push(`Recovery: ${status.recovery.message}`);
    if (status.recovery.operation === "stop") {
      lines.push(
        `Recovery command: supabase stack stop --stack-id ${status.id} && supabase stack start --stack-id ${status.id}`,
      );
    } else {
      lines.push(`Recovery command: supabase stack destroy --stack-id ${status.id}`);
      lines.push("Warning: destroy is destructive and removes the stack data.");
    }
  }
  return lines;
};

export const renderStackStatus = (status: StackStatus): string => {
  const lines = [
    `Stack ${status.id}`,
    `Runtime: ${status.runtime.kind}`,
    `Lifecycle: ${status.lifecycle}`,
  ];
  const endpoints = Object.entries(status.endpoints);
  if (endpoints.length > 0) {
    lines.push("Endpoints:");
    for (const [name, endpoint] of endpoints)
      if (endpoint !== undefined) lines.push(`  ${name}: ${endpoint.url}`);
  }
  const dormant = status.capabilities.filter(({ state }) => state === "dormant");
  if (dormant.length > 0)
    lines.push(`Dormant capabilities: ${dormant.map(({ name }) => name).join(", ")}`);
  lines.push(...stackStatusIssueLines(status));
  return `${lines.join("\n")}\n`;
};

/** Runtime configuration for the first stack command. Later commands reuse this layer. */
export const stackTargetResolverLayer = Layer.succeed(StackTargetResolver, {
  resolve: (input) =>
    Effect.gen(function* () {
      const id = input.id === undefined ? undefined : yield* validateStackId(input.id);
      const stackApi = yield* StackApi;
      const inspection =
        id === undefined
          ? undefined
          : yield* stackApi.inspectStack(id).pipe(
              Effect.mapError(
                (error) =>
                  new StackTargetError({
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
        return yield* new StackTargetError({
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
