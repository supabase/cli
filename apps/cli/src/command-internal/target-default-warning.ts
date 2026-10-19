import { Effect } from "effect";

import { Output } from "../shared/output/output.service.ts";
import { yellow } from "./colors.ts";

/** Warns on stderr that a run with no target selector reaches the linked project, which the next major replaces with the local one. */
export const warnLinkedTargetDefault = Effect.fnUntraced(function* (input: {
  readonly command: string;
  readonly targetSelected: boolean;
  readonly localTarget?: string;
}) {
  if (input.targetSelected) return;
  const output = yield* Output;
  const localTarget = input.localTarget ?? "the local database";
  yield* output.raw(
    `${yellow(
      `Warning: supabase ${input.command} will target ${localTarget} by default in the next major version. Pass --linked to keep targeting the linked project.`,
    )}\n`,
    "stderr",
  );
});
