// oxlint-disable-next-line effecttsgo/node-builtin-import -- phase file is a host-side probe; FileSystem has no append.
import { appendFileSync } from "node:fs";
import { Effect } from "effect";

/** Appends a timestamp when `SUPABASE_SHADOW_PHASE_FILE` is set. */
export const shadowPhase = (label: string) =>
  Effect.suspend(() => {
    // Config and Clock would add ConfigError to service methods that call this probe.
    // oxlint-disable-next-line effecttsgo/process-env-in-effect -- service-free probe, see above.
    const file = process.env["SUPABASE_SHADOW_PHASE_FILE"];
    if (file === undefined || file.length === 0) return Effect.void;
    return Effect.try(() => {
      // oxlint-disable-next-line effecttsgo/global-date-in-effect -- service-free probe, see above.
      appendFileSync(file, `${Date.now()} ${process.pid} ${label}\n`);
    }).pipe(Effect.ignore);
  });
