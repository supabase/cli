import type { Effect } from "effect";
import { Context } from "effect";
import type { GoChildExitError } from "./go-child-exit.error.ts";

interface GoProxyShape {
  /**
   * Forwards args to the Go binary, inheriting stdio and propagating the exit code. Fails with
   * `GoChildExitError` (carrying the exact exit code) on a non-zero exit or an unresolvable
   * binary.
   *
   * `opts.suppressChildTelemetry` disables telemetry in the child; set it only when the caller's
   * own command instrumentation already emits `cli_command_executed`, since a pure proxy
   * handler's Go child is its only telemetry emitter.
   */
  readonly exec: (
    args: ReadonlyArray<string>,
    opts?: {
      readonly cwd?: string;
      readonly env?: Record<string, string>;
      readonly suppressChildTelemetry?: boolean;
    },
  ) => Effect.Effect<void, GoChildExitError>;

  /**
   * Like `exec`, but captures the child's stdout and returns it as a string instead of
   * inheriting it; stderr stays inherited. Fails with `GoChildExitError` the same way `exec`
   * does.
   *
   * `opts.stdin: "ignore"` gives the child a non-TTY stdin so a prompt (Go's `PromptYesNo`)
   * takes its default instead of blocking — required when a machine-output caller delegates a
   * command that would otherwise prompt before the JSON envelope is emitted.
   */
  readonly execCapture: (
    args: ReadonlyArray<string>,
    opts?: {
      readonly cwd?: string;
      readonly env?: Record<string, string>;
      readonly stdin?: "inherit" | "ignore";
      readonly suppressChildTelemetry?: boolean;
    },
  ) => Effect.Effect<string, GoChildExitError>;
}

export class GoProxy extends Context.Service<GoProxy, GoProxyShape>()("supabase/cli/GoProxy") {}
