import { Effect, Option } from "effect";
import { OutputFlag } from "../../command-internal/global-flags.ts";
import { encodeGoJson, encodeToml, encodeYaml } from "../../command-internal/go-output.encoders.ts";
import { Output } from "../../shared/output/output.service.ts";
import { NotebooksEnvNotSupportedError } from "./notebooks.errors.ts";

/**
 * The `-o`/`--output` policy for notebooks payloads: which formats answer with
 * a payload, how that payload is encoded, and an up-front refusal of `-o env`.
 *
 * Knowingly duplicated from `commands/experimental/compute/compute.output.ts`,
 * which carries the same policy for the compute family. None of it is
 * notebooks-specific, so the honest shape is one `command-internal` helper
 * parameterized by each family's env-not-supported error.
 *
 * It is kept as a copy so adding `notebooks` does not edit a command family
 * that already ships — the two copies are independent, and a bug introduced
 * here cannot reach `compute`. Fold them together when a third family wants the
 * same policy, at which point the shared version can be reviewed on its own
 * rather than inside a feature PR.
 *
 * Until then the copies are expected to agree: a change to the allowlist or to
 * the encoding here almost certainly belongs in `compute.output.ts` too.
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

export const emitNotebooksMachineOutput = Effect.fnUntraced(function* (
  payload: Record<string, unknown>,
) {
  const output = yield* Output;
  const goFormat = Option.getOrUndefined(yield* OutputFlag);

  if (!emitsPayloadFor(goFormat)) {
    return false;
  }

  if (goFormat === "env") {
    // Unreachable when the command called `rejectNotebooksEnvOutput` first,
    // which is where the refusal belongs; here as the backstop that stops a new
    // command silently emitting TOML for `-o env`.
    return yield* new NotebooksEnvNotSupportedError({
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
export const notebooksMachineOutputRequested = Effect.fnUntraced(function* () {
  return emitsPayloadFor(Option.getOrUndefined(yield* OutputFlag));
});

/**
 * Refuses `-o env` before the command does anything.
 *
 * Every notebooks payload has structure a flat `KEY=value` list cannot hold.
 * Refused up front rather than at emit time, since for `push` that would mean
 * failing only after the remote project has already changed.
 */
export const rejectNotebooksEnvOutput = Effect.fnUntraced(function* () {
  if (Option.getOrUndefined(yield* OutputFlag) === "env") {
    return yield* new NotebooksEnvNotSupportedError({
      message: "--output env flag is not supported",
    });
  }
});
