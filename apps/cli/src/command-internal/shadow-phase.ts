// oxlint-disable-next-line effecttsgo/node-builtin-import -- phase file is a CLI-side probe; FileSystem has no append.
import { appendFileSync } from "node:fs";
import { Effect } from "effect";

/** Appends a timestamp when `SUPABASE_SHADOW_PHASE_FILE` is set. */
export const shadowPhase = (label: string) =>
  Effect.suspend(() => {
    const file = process.env["SUPABASE_SHADOW_PHASE_FILE"];
    if (file === undefined || file.length === 0) return Effect.void;
    return Effect.try(() => {
      appendFileSync(file, `${Date.now()} ${process.pid} ${label}\n`);
    }).pipe(Effect.ignore);
  });
