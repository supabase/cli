import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";

import { stripAnsi } from "./ansi.ts";
import { VALID_REF } from "./command-mocks.ts";

export interface TargetRunOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly failure?: string;
}

export const targetDefaultWarning = (command: string, localTarget = "the local database") =>
  `Warning: supabase ${command} will target ${localTarget} by default in the next major version. Pass --linked to keep targeting the linked project.`;

/** The failure message a run ended with, or `undefined` when it succeeded. */
export const describeFailure = (exit: Exit.Exit<unknown, unknown>): string | undefined => {
  if (Exit.isSuccess(exit)) return undefined;
  const error = exit.cause.reasons.find(Cause.isFailReason)?.error;
  return error instanceof Error ? error.message : Cause.pretty(exit.cause);
};

/** Writes (`linked`) or removes the `supabase link` ref file in `workdir`. */
export const setLinkedRefFile = (workdir: string, linked: boolean, ref = VALID_REF) => {
  const tempDir = join(workdir, "supabase", ".temp");
  if (linked) {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, "project-ref"), ref);
  } else {
    rmSync(join(tempDir, "project-ref"), { force: true });
  }
};

/**
 * A bare run warns exactly once and otherwise prints what the `sameTarget` selector prints; every
 * selector run stays silent. `run(undefined)` is the bare run. When `runUnlinked` is given, a bare
 * run with no linked project ref configured stays silent and ends the way `sameTarget` does, and
 * with `unlinkedFailure` it must fail with exactly that message.
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
  readonly runUnlinked?: (selector: S | undefined) => Effect.Effect<TargetRunOutput, E, R>;
  readonly unlinkedFailure?: string;
}) {
  const warning = `${targetDefaultWarning(input.command, input.localTarget)}\n`;
  const bare = yield* input.run(undefined);
  const baseline = yield* input.run(input.sameTarget);

  const bareStderr = stripAnsi(bare.stderr);
  expect(bareStderr.split(warning)).toHaveLength(2);
  expect(bareStderr.replace(warning, "")).toBe(stripAnsi(baseline.stderr));
  expect(bare.stdout).toBe(baseline.stdout);
  expect(bare.failure).toBe(baseline.failure);

  for (const selector of input.selectors) {
    const { stderr } = yield* input.run(selector);
    expect(stripAnsi(stderr), selector.label).not.toContain("by default in the next major version");
  }

  if (input.runUnlinked === undefined) return;
  const unlinkedBare = yield* input.runUnlinked(undefined);
  const unlinkedBaseline = yield* input.runUnlinked(input.sameTarget);
  expect(stripAnsi(unlinkedBare.stderr)).not.toContain("by default in the next major version");
  expect(unlinkedBare.stderr).toBe(unlinkedBaseline.stderr);
  expect(unlinkedBare.stdout).toBe(unlinkedBaseline.stdout);
  expect(unlinkedBare.failure).toBe(unlinkedBaseline.failure);
  if (input.unlinkedFailure !== undefined) {
    expect(unlinkedBare.failure).toBe(input.unlinkedFailure);
  }
});
