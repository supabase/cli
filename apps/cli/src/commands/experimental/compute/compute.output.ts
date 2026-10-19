import { Effect, Option } from "effect";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import type { RemoteValue } from "../../../command-internal/target/remote-value.ts";
import { Output } from "../../../shared/output/output.service.ts";
import {
  encodeSortedJson,
  encodeToml,
  encodeYaml,
} from "../../../command-internal/output.encoders.ts";
import { ComputeEnvNotSupportedError } from "./compute.errors.ts";

/**
 * Which `-o` values these commands answer with a payload.
 *
 * An allowlist, not a denylist, so an unrecognized future `-o` value falls
 * through to text instead of silently serializing as TOML. `env` is included
 * so it reaches the refusal below rather than being treated as unrecognized.
 */
const PAYLOAD_FORMATS = new Set(["json", "yaml", "toml", "env"]);

function emitsPayloadFor(outputFlagFormat: string | undefined): boolean {
  return outputFlagFormat !== undefined && PAYLOAD_FORMATS.has(outputFlagFormat);
}

export const emitComputeMachineOutput = Effect.fnUntraced(function* (
  payload: Record<string, unknown>,
) {
  const output = yield* Output;
  const outputFlagFormat = Option.getOrUndefined(yield* OutputFlag);

  if (!emitsPayloadFor(outputFlagFormat)) {
    return false;
  }

  if (outputFlagFormat === "env") {
    // Unreachable when the command called `rejectComputeEnvOutput` first,
    // which is where the refusal belongs; here as the backstop that stops a new
    // command silently emitting TOML for `-o env`.
    return yield* new ComputeEnvNotSupportedError({
      message: "--output env flag is not supported",
    });
  }

  if (outputFlagFormat === "json") {
    yield* output.raw(encodeSortedJson(payload));
    return true;
  }
  if (outputFlagFormat === "yaml") {
    yield* output.raw(encodeYaml(payload));
    return true;
  }
  yield* output.raw(encodeToml(payload));
  return true;
});

/**
 * Whether a machine-readable stdout was requested via `-o`. Callers that emit
 * human lines *before* their payload need this: the `-o` branch runs at the end,
 * by which point those lines would already be on stdout.
 */
export const computeMachineOutputRequested = Effect.fnUntraced(function* () {
  return emitsPayloadFor(Option.getOrUndefined(yield* OutputFlag));
});

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
  const outputFlagFormat = Option.getOrUndefined(yield* OutputFlag);
  const forcesText = outputFlagFormat !== undefined && !emitsPayloadFor(outputFlagFormat);
  return forcesText ? ("text" as const) : output.format;
});

/**
 * Refuses `-o env` before the command does anything.
 *
 * Every compute payload has structure a flat `KEY=value` list cannot hold.
 * Refused up front rather than at emit time, since for `push` that would mean
 * failing only after the remote project has already changed.
 */
export const rejectComputeEnvOutput = Effect.fnUntraced(function* () {
  if (Option.getOrUndefined(yield* OutputFlag) === "env") {
    return yield* new ComputeEnvNotSupportedError({
      message: "--output env flag is not supported",
    });
  }
});

/**
 * The ` --remote=<ref>` a retry suggestion has to carry, or `""` when the project came from the
 * link.
 *
 * Dropping an explicit selector from a copy-pasted suggestion would re-resolve to whichever
 * project is currently linked — for `delete --yes`, a same-named compute deleted without a
 * prompt. Keyed off the flags, not the resolved ref, so a link-supplied ref isn't echoed back as
 * noise; the resolved ref also stands in for a branch name, which needs no second lookup.
 */
export const computeRemoteSuffix = (
  flags: {
    readonly remote: Option.Option<RemoteValue>;
    readonly projectRef: Option.Option<string>;
  },
  ref: string,
): string =>
  Option.isSome(flags.projectRef) || Option.exists(flags.remote, (value) => value._tag !== "Linked")
    ? ` --remote=${ref}`
    : "";
