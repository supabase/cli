import { Effect, Option } from "effect";
import { LegacyOutputFlag } from "../../../shared/legacy/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import {
  encodeEnv,
  encodeGoJson,
  encodeToml,
  encodeYaml,
} from "../../shared/legacy-go-output.encoders.ts";
import { LegacyWorkersEnvNotSupportedError } from "./workers.errors.ts";

/**
 * Emits a command's payload in the format `-o`/`--output` asked for.
 *
 * `-o` is a global flag on this shell that 33 of its 37 command families
 * honour, so a workers command that ignored it would print human text to a
 * stdout the user had asked to be machine-readable. What it does *not* inherit
 * is the Go-parity obligation: the struct-shaped encoders exist to reproduce a
 * Go type's byte output, and `supabase workers` has no Go counterpart, so it
 * serialises its own payload through the generic encoders instead.
 *
 * Returns whether it emitted anything, so the caller can skip its text
 * rendering — `output.success` writes to stdout in text mode and would corrupt
 * the payload otherwise.
 */
export const legacyEmitWorkersGoOutput = Effect.fnUntraced(function* (
  payload: Record<string, unknown>,
) {
  const output = yield* Output;
  const goFormat = Option.getOrUndefined(yield* LegacyOutputFlag);

  if (goFormat === undefined || goFormat === "pretty") {
    return false;
  }

  if (goFormat === "env") {
    if (Object.values(payload).some((value) => Array.isArray(value))) {
      return yield* new LegacyWorkersEnvNotSupportedError({
        message: "--output env flag is not supported",
      });
    }
    yield* output.raw(`${encodeEnv(payload)}\n`);
    return true;
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
