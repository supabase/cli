import { Effect, Option } from "effect";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import {
  encodeGoJson,
  encodeToml,
  encodeYaml,
} from "../../../command-internal/go-output.encoders.ts";
import { WorkersEnvNotSupportedError } from "./workers.errors.ts";

/**
 * Emits a command's payload in the format `-o`/`--output` asked for.
 *
 * Returns whether it emitted anything, so the caller can skip its own text
 * rendering, which would otherwise also write to stdout and corrupt the payload.
 */
/**
 * Which `-o` values these commands answer with a payload.
 *
 * An allowlist, not a denylist, so an unrecognized future `-o` value falls
 * through to text instead of silently serializing as TOML. `env` is included
 * so it reaches the refusal below rather than being treated as unrecognized.
 */
const PAYLOAD_FORMATS = new Set(["json", "yaml", "toml", "env"]);

function emitsPayloadFor(goFormat: string | undefined): boolean {
  return goFormat !== undefined && PAYLOAD_FORMATS.has(goFormat);
}

export const emitWorkersMachineOutput = Effect.fnUntraced(function* (
  payload: Record<string, unknown>,
) {
  const output = yield* Output;
  const goFormat = Option.getOrUndefined(yield* OutputFlag);

  if (!emitsPayloadFor(goFormat)) {
    return false;
  }

  if (goFormat === "env") {
    // Unreachable once a command has already called `rejectWorkersEnvOutput`;
    // this is the backstop for a command that forgets to.
    return yield* new WorkersEnvNotSupportedError({
      message: "--output env flag is not supported",
    });
  }

  if (goFormat === "json") {
    yield* output.raw(encodeGoJson(payload));
    return true;
  }
  if (goFormat === "yaml") {
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
export const workersMachineOutputRequested = Effect.fnUntraced(function* () {
  return emitsPayloadFor(Option.getOrUndefined(yield* OutputFlag));
});

/**
 * The format a run actually renders in, with `-o` given priority over
 * `--output-format`.
 *
 * `-o pretty|table|csv` fall through to text, so branching on `output.format`
 * alone would wrongly emit JSON for `-o pretty --output-format json`.
 * `-o json|yaml|toml|env` are excluded because `emitWorkersMachineOutput`
 * already owns those and their stdout.
 */
export const workersRenderFormat = Effect.fnUntraced(function* () {
  const output = yield* Output;
  const goFormat = Option.getOrUndefined(yield* OutputFlag);
  const forcesText = goFormat !== undefined && !emitsPayloadFor(goFormat);
  return forcesText ? ("text" as const) : output.format;
});

/**
 * Refuses `-o env` before the command does anything.
 *
 * Every workers payload has structure a flat `KEY=value` list cannot hold.
 * Refused up front rather than at emit time, since for `push` that would mean
 * failing only after the remote project has already changed.
 */
export const rejectWorkersEnvOutput = Effect.fnUntraced(function* () {
  if (Option.getOrUndefined(yield* OutputFlag) === "env") {
    return yield* new WorkersEnvNotSupportedError({
      message: "--output env flag is not supported",
    });
  }
});

/**
 * The `--project-ref` a retry suggestion has to carry, or `""` when it came
 * from the link.
 *
 * Dropping an explicit `--project-ref` from a copy-pasted suggestion would
 * re-resolve to whichever project is currently linked — for `delete --yes`,
 * a same-named worker deleted without a prompt. Keyed off the flag, not the
 * resolved ref, so a link-supplied ref isn't echoed back as noise; an empty
 * flag value counts as "not supplied", matching `ProjectRefResolver`.
 */
export const workersProjectRefSuffix = (projectRef: Option.Option<string>): string =>
  Option.isSome(projectRef) && projectRef.value.length > 0
    ? ` --project-ref ${projectRef.value}`
    : "";
