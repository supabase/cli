import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { stripAnsi } from "./ansi.ts";

export interface TargetRunOutput {
  readonly stdout: string;
  readonly stderr: string;
}

export const targetDefaultWarning = (command: string, localTarget = "the local database") =>
  `Warning: supabase ${command} will target ${localTarget} by default in the next major version. Pass --linked to keep targeting the linked project.`;

/**
 * A bare run warns exactly once and otherwise prints what the `sameTarget` selector prints; every
 * selector run stays silent. `run(undefined)` is the bare run.
 */
export const assertTargetDefaultWarning = Effect.fnUntraced(function* <
  S extends { readonly label: string },
  E,
  R,
>(input: {
  readonly command: string;
  readonly localTarget?: string;
  readonly sameTarget: S;
  readonly selectors: ReadonlyArray<S>;
  readonly run: (selector: S | undefined) => Effect.Effect<TargetRunOutput, E, R>;
}) {
  const warning = `${targetDefaultWarning(input.command, input.localTarget)}\n`;
  const bare = yield* input.run(undefined);
  const baseline = yield* input.run(input.sameTarget);

  const bareStderr = stripAnsi(bare.stderr);
  expect(bareStderr.split(warning)).toHaveLength(2);
  expect(bareStderr.replace(warning, "")).toBe(stripAnsi(baseline.stderr));
  expect(bare.stdout).toBe(baseline.stdout);

  for (const selector of input.selectors) {
    const { stderr } = yield* input.run(selector);
    expect(stripAnsi(stderr), selector.label).not.toContain("by default in the next major version");
  }
});
