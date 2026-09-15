import { Effect, Option } from "effect";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { resourceOutput } from "../../../command-internal/resource-output.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { ComputeEnvNotSupportedError } from "./compute.errors.ts";

export const {
  emit: emitComputeMachineOutput,
  requested: computeMachineOutputRequested,
  rejectEnv: rejectComputeEnvOutput,
} = resourceOutput(ComputeEnvNotSupportedError);

/**
 * The format a run actually renders in, with `-o` given priority over
 * `--output-format`.
 *
 * `-o pretty|table|csv` fall through to text, so branching on `output.format`
 * alone would wrongly emit JSON for `-o pretty --output-format json`.
 * `-o json|yaml|toml|env` are excluded because `emitComputeMachineOutput`
 * already owns those and their stdout.
 */
export const computeRenderFormat = Effect.fnUntraced(function* () {
  const output = yield* Output;
  const goFormat = Option.getOrUndefined(yield* OutputFlag);
  const forcesText = goFormat !== undefined && !(yield* computeMachineOutputRequested());
  return forcesText ? ("text" as const) : output.format;
});

/**
 * The `--project-ref` a retry suggestion has to carry, or `""` when it came
 * from the link.
 *
 * Dropping an explicit `--project-ref` from a copy-pasted suggestion would
 * re-resolve to whichever project is currently linked — for `delete --yes`,
 * a same-named compute deleted without a prompt. Keyed off the flag, not the
 * resolved ref, so a link-supplied ref isn't echoed back as noise; an empty
 * flag value counts as "not supplied", matching `ProjectRefResolver`.
 */
export const computeProjectRefSuffix = (projectRef: Option.Option<string>): string =>
  Option.isSome(projectRef) && projectRef.value.length > 0
    ? ` --project-ref ${projectRef.value}`
    : "";
