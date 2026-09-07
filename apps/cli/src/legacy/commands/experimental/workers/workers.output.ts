import { Effect, Option } from "effect";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { encodeGoJson, encodeToml, encodeYaml } from "../../../shared/legacy-go-output.encoders.ts";
import { LegacyWorkersEnvNotSupportedError } from "./workers.errors.ts";

/**
 * Emits a command's payload in the format `-o`/`--output` asked for.
 *
 * `-o` is a global flag nearly every command family on this shell honours, so
 * ignoring it would print human text to a stdout the user asked to be
 * machine-readable.
 *
 * The struct-shaped encoders elsewhere reproduce a payload shape their command
 * is required to match. `workers` has none, so it serialises through the generic
 * encoders and shapes its payload as the command reads best.
 *
 * Returns whether it emitted anything, so the caller can skip its text
 * rendering — `output.success` writes to stdout in text mode and would corrupt
 * the payload otherwise.
 */
/**
 * Which `-o` values these commands answer with a payload.
 *
 * An allowlist, because the emitter's last branch is TOML: a denylist made every
 * value it had not heard of serialise as TOML, so the next format the global
 * flag learns would silently emit TOML from every workers command until somebody
 * remembered to exclude it. `pretty` is the human default, and `table`/`csv` are
 * accepted by the global flag only because `db query` reads them — every
 * resource command falls through to its own text rendering for those, which is
 * what an unrecognised value should do too.
 *
 * `env` is in the set so it reaches the refusal below rather than falling
 * through to text: it is a format these commands *recognise* and cannot encode,
 * which is a different answer from one they have never heard of.
 */
const PAYLOAD_FORMATS = new Set(["json", "yaml", "toml", "env"]);

function emitsPayloadFor(goFormat: string | undefined): boolean {
  return goFormat !== undefined && PAYLOAD_FORMATS.has(goFormat);
}

export const legacyEmitWorkersMachineOutput = Effect.fnUntraced(function* (
  payload: Record<string, unknown>,
) {
  const output = yield* Output;
  const goFormat = Option.getOrUndefined(yield* LegacyOutputFlag);

  if (!emitsPayloadFor(goFormat)) {
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
  return emitsPayloadFor(Option.getOrUndefined(yield* LegacyOutputFlag));
});

/**
 * The format a run actually renders in, with `-o` given priority over
 * `--output-format`.
 *
 * `-o pretty|table|csv` encode nothing and fall through to the text rendering,
 * and an explicit `-o` outranks `--output-format` when both are set. Branching
 * on `output.format` alone therefore emitted JSON for `-o pretty
 * --output-format json`, which asked for exactly the opposite.
 *
 * `-o json|yaml|toml|env` are absent from the result on purpose: those are
 * handled by `legacyEmitWorkersMachineOutput`, which runs before any of this and
 * owns its own stdout.
 */
export const legacyWorkersRenderFormat = Effect.fnUntraced(function* () {
  const output = yield* Output;
  const goFormat = Option.getOrUndefined(yield* LegacyOutputFlag);
  const forcesText = goFormat !== undefined && !emitsPayloadFor(goFormat);
  return forcesText ? ("text" as const) : output.format;
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

/**
 * The `--project-ref` a retry suggestion has to carry, or `""` when the ref came
 * from the link.
 *
 * A suggested command is copy-pasted verbatim, so one that drops an explicit
 * `--project-ref` re-resolves to whatever *this* checkout is linked to. On
 * `delete --yes` that is a same-named worker in a project the user never named,
 * removed without a prompt.
 *
 * Keyed off the flag rather than the resolved ref: when the link supplied it,
 * appending it again is noise on a command that already resolves correctly.
 *
 * An empty `--project-ref ""` counts as "not supplied", the same reading
 * `LegacyProjectRefResolver` gives it before falling back to the environment or
 * the linked-project file. Carrying it through would suggest a command ending
 * in a valueless `--project-ref`, which cannot be pasted back.
 */
export const legacyWorkersProjectRefSuffix = (projectRef: Option.Option<string>): string =>
  Option.isSome(projectRef) && projectRef.value.length > 0
    ? ` --project-ref ${projectRef.value}`
    : "";
