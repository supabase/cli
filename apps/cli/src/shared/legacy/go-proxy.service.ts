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
}

export class LegacyGoProxy extends Context.Service<LegacyGoProxy, LegacyGoProxyShape>()(
  "supabase/legacy/LegacyGoProxy",
) {}
