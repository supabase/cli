import type { Effect } from "effect";
import { Context } from "effect";

interface LegacyGoProxyShape {
  /**
   * Forward the given args to the Go binary, inheriting stdin/stdout/stderr
   * and propagating the exit code. On a non-zero exit the process exits with
   * the same code — callers do not need to handle the failure case.
   *
   * `opts.cwd` overrides the working directory for this call (falls back to the
   * layer's construction-time cwd). `opts.env` overlays extra environment
   * variables onto the subprocess (merged on top of the inherited process env);
   * use it to pass values the user supplied as environment variables back to the
   * proxy as environment variables, rather than cross-mapping them onto CLI
   * flags (CLI-1617).
   */
  readonly exec: (
    args: ReadonlyArray<string>,
    opts?: { readonly cwd?: string; readonly env?: Record<string, string> },
  ) => Effect.Effect<void>;

  /**
   * Like `exec`, but captures the child's stdout and returns it as a string
   * instead of inheriting stdout. stderr is still inherited (so progress /
   * diagnostics pass straight through), and a non-zero exit still terminates the
   * process with the same code.
   *
   * `opts.stdin` controls the child's stdin: `"inherit"` (default) keeps the
   * child interactive (its prompts reach the terminal); `"ignore"` gives it a
   * non-TTY stdin so prompts (Go's `PromptYesNo`) take their default instead of
   * blocking — required when a machine-output caller delegates a command that
   * would otherwise prompt before the JSON envelope is emitted.
   *
   * Used in machine-output mode (`--output-format json|stream-json`) to wrap a
   * delegated engine's stdout in a structured payload, instead of letting the
   * child's raw bytes land on stdout and corrupt the JSON envelope (the CLI-1546
   * "stdout is payload-only in machine mode" invariant).
   */
  readonly execCapture: (
    args: ReadonlyArray<string>,
    opts?: {
      readonly cwd?: string;
      readonly env?: Record<string, string>;
      readonly stdin?: "inherit" | "ignore";
    },
  ) => Effect.Effect<string>;
}

export class LegacyGoProxy extends Context.Service<LegacyGoProxy, LegacyGoProxyShape>()(
  "supabase/legacy/LegacyGoProxy",
) {}
