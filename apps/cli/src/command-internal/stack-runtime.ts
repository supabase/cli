import { Data, Effect } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { RuntimeInfo } from "../shared/runtime/runtime-info.service.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";

/** Runtime that executes a local stack's services. */
export type StackRuntime = "native" | "docker" | "podman";

/** Raised when automatic selection finds no reachable container engine on a host without native support. */
export class StackRuntimeSelectionError extends Data.TaggedError("StackRuntimeSelectionError")<{
  readonly message: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dockerNotRunning;
  }
}

/** A cold Docker Desktop or Podman machine can take several seconds to answer its first request. */
const PROBE_TIMEOUT = "10 seconds";

/** Each probe exits non-zero unless the engine's daemon or service answers. */
const engineProbes = [
  { runtime: "docker", args: ["version", "--format", "{{.Server.Version}}"] },
  { runtime: "podman", args: ["info", "--format", "{{.Version.Version}}"] },
] as const;

const engineReachable = (
  spawner: ChildProcessSpawner["Service"],
  probe: (typeof engineProbes)[number],
) =>
  spawner
    .exitCode(
      ChildProcess.make(probe.runtime, probe.args, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }),
    )
    .pipe(
      Effect.timeout(PROBE_TIMEOUT),
      Effect.map((exitCode) => exitCode === 0),
      Effect.orElseSucceed(() => false),
    );

const nativeSupported = (platform: string, arch: string): boolean =>
  (platform === "linux" && (arch === "x64" || arch === "arm64")) ||
  (platform === "darwin" && arch === "arm64");

/**
 * Returns the requested or saved runtime unchanged; otherwise the first of Docker, Podman, or
 * native that is usable on this host.
 */
export const selectStackRuntime = Effect.fn("StackRuntime.select")(function* (
  requested: StackRuntime | undefined,
) {
  if (requested !== undefined) return requested;
  const spawner = yield* ChildProcessSpawner;
  for (const probe of engineProbes) {
    if (yield* engineReachable(spawner, probe)) return probe.runtime;
  }
  const { platform, arch } = yield* RuntimeInfo;
  if (nativeSupported(platform, arch)) return "native";
  return yield* new StackRuntimeSelectionError({
    message: `Neither Docker nor Podman is reachable, and native stacks are not supported on ${platform}/${arch}.`,
    suggestion: "Start Docker or Podman, then rerun the command.",
  });
});
