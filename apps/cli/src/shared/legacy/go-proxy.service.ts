import type { Effect } from "effect";
import { ServiceMap } from "effect";

interface LegacyGoProxyShape {
  /**
   * Forward the given args to the Go binary, inheriting stdin/stdout/stderr
   * and propagating the exit code. On a non-zero exit the process exits with
   * the same code — callers do not need to handle the failure case.
   */
  readonly exec: (args: ReadonlyArray<string>) => Effect.Effect<void>;
}

export class LegacyGoProxy extends ServiceMap.Service<LegacyGoProxy, LegacyGoProxyShape>()(
  "@supabase/cli/legacy/LegacyGoProxy",
) {}
