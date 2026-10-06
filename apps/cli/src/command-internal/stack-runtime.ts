import { defaultRuntime } from "@supabase/stack/internal/artifacts";
import { resolveEngineTarget, type ContainerEngine } from "@supabase/stack/internal/engine";
import { Data, Effect } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { RuntimeInfo } from "../shared/runtime/runtime-info.service.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import { PropStackRuntime } from "../shared/telemetry/event-catalog.ts";
import { recordCommandTelemetry } from "../telemetry/command-telemetry-attributes.ts";

/** Runtime that executes a local stack's services. */
export type StackRuntime = "native" | "docker" | "podman";

/** Records the runtime of the stack the enclosing command operates on. */
export const recordStackRuntimeTelemetry = (runtime: StackRuntime) =>
  recordCommandTelemetry({ [PropStackRuntime]: runtime });

/** Raised when no reachable container engine exists or native is requested on an unsupported host. */
export class StackRuntimeSelectionError extends Data.TaggedError("StackRuntimeSelectionError")<{
  readonly reason: "engine-unreachable" | "native-unsupported";
  readonly message: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.reason === "native-unsupported"
      ? actionability.provideFlags
      : actionability.dockerNotRunning;
  }
}

/** A cold Docker Desktop or Podman machine can take several seconds to answer its first request. */
const PROBE_TIMEOUT = "10 seconds";

/**
 * Resolves the engine target the owner would pin, so selection and startup agree on which endpoint
 * answers; resolution reads the engine's identity, so success means the engine is reachable.
 */
const engineReachable = Effect.fn("StackRuntime.probeEngine")(function* (
  spawner: ChildProcessSpawner["Service"],
  engine: ContainerEngine,
) {
  yield* Effect.annotateCurrentSpan({ "container.engine": engine });
  const reachable = yield* resolveEngineTarget(spawner, engine).pipe(
    Effect.as(true),
    Effect.timeout(PROBE_TIMEOUT),
    Effect.orElseSucceed(() => false),
  );
  yield* Effect.annotateCurrentSpan({ "container.reachable": reachable });
  return reachable;
});

/** Display name of a container runtime. */
export const containerEngineName = (runtime: ContainerEngine) =>
  runtime === "docker" ? "Docker" : "Podman";

/**
 * Notice for a new stack whose automatic selection skipped Docker, since that runtime is saved with
 * the stack; `undefined` when the runtime was requested, saved, or Docker.
 */
export const automaticRuntimeNotice = (
  requested: StackRuntime | undefined,
  selected: StackRuntime,
): string | undefined =>
  requested !== undefined || selected === "docker"
    ? undefined
    : `Docker didn't answer, so this new stack uses the ${selected === "podman" ? "Podman" : "native"} runtime, which is saved with the stack. To use Docker, start it, then run \`supabase stack destroy\` and start again, or choose a different --stack name with --runtime docker.`;

/** Returns the requested or saved runtime unchanged; otherwise the first of Docker, Podman, or native that is usable on this host. */
export const selectStackRuntime = Effect.fn("StackRuntime.select")(function* (
  requested: StackRuntime | undefined,
) {
  if (requested !== undefined) {
    if (requested === "native") {
      const { platform, arch } = yield* RuntimeInfo;
      // Fail before a stack is created; the runtime's own check only runs mid-start.
      if (defaultRuntime({ os: platform, arch }) !== "native")
        return yield* new StackRuntimeSelectionError({
          reason: "native-unsupported",
          message: `Native artifacts are unsupported on ${platform}/${arch}.`,
          suggestion:
            "Start Docker or Podman and rerun with --runtime docker or --runtime podman; if this stack already exists as native, run supabase stack destroy first.",
        });
    }
    return requested;
  }
  const spawner = yield* ChildProcessSpawner;
  for (const engine of ["docker", "podman"] as const) {
    if (yield* engineReachable(spawner, engine)) return engine;
  }
  const { platform, arch } = yield* RuntimeInfo;
  if (defaultRuntime({ os: platform, arch }) === "native") return "native";
  return yield* new StackRuntimeSelectionError({
    reason: "engine-unreachable",
    message: `Neither Docker nor Podman is reachable, and native stacks are not supported on ${platform}/${arch}.`,
    suggestion: "Start Docker or Podman, then rerun the command.",
  });
}, Effect.tap(recordStackRuntimeTelemetry));
