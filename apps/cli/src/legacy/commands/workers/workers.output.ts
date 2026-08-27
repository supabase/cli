import { Effect, Option } from "effect";
import { LegacyOutputFlag } from "../../../shared/legacy/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { encodeGoJson, encodeToml, encodeYaml } from "../../shared/legacy-go-output.encoders.ts";
import { LegacyWorkersEnvNotSupportedError } from "./workers.errors.ts";

/**
 * Emits a command's payload in the format `-o`/`--output` asked for.
 *
 * `-o` is a global flag nearly every command family on this shell honours, so
 * ignoring it would print human text to a stdout the user asked to be
 * machine-readable.
 *
 * The struct-shaped encoders elsewhere reproduce a payload shape their command
 * already shipped. `workers` has none to match, so it serialises through the
 * generic encoders and shapes its payload as the command reads best.
 *
 * Returns whether it emitted anything, so the caller can skip its text
 * rendering — `output.success` writes to stdout in text mode and would corrupt
 * the payload otherwise.
 */
export const legacyEmitWorkersMachineOutput = Effect.fnUntraced(function* (
  payload: Record<string, unknown>,
) {
  const output = yield* Output;
  const goFormat = Option.getOrUndefined(yield* LegacyOutputFlag);

  if (goFormat === undefined || goFormat === "pretty") {
    return false;
  }

  if (goFormat === "env") {
    // Unreachable when the command called `legacyRejectWorkersEnvOutput` first,
    // which is where the refusal belongs; here as the backstop that stops a new
    // command silently emitting TOML for `-o env`.
    return yield* new LegacyWorkersEnvNotSupportedError({
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
export const legacyWorkersMachineOutputRequested = Effect.fnUntraced(function* () {
  const goFormat = Option.getOrUndefined(yield* LegacyOutputFlag);
  return goFormat !== undefined && goFormat !== "pretty";
});

/**
 * Refuse `-o env` before the command does anything.
 *
 * `env` is a flat `KEY=value` list and every workers payload has structure a
 * flat list cannot hold — a collection, or a nested instance tally. So it is
 * refused for the whole command family rather than per payload, and refused up
 * front: discovering it at emit time means failing after the work is done, which
 * for `push` is after the remote project has already changed.
 */
export const legacyRejectWorkersEnvOutput = Effect.fnUntraced(function* () {
  if (Option.getOrUndefined(yield* LegacyOutputFlag) === "env") {
    return yield* new LegacyWorkersEnvNotSupportedError({
      message: "--output env flag is not supported",
    });
  }
});
