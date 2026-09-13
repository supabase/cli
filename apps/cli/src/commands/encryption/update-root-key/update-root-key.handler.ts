import { Effect, Option } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { aqua } from "../../../command-internal/colors.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { Stdin } from "../../../shared/runtime/stdin.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { mapEncryptionHttpError } from "../encryption.errors.ts";
import type { EncryptionUpdateRootKeyFlags } from "./update-root-key.command.ts";

const mapUpdateError = mapEncryptionHttpError({
  networkVerb: "update",
  statusVerb: "update",
});

export const encryptionUpdateRootKey = Effect.fn("encryption.update-root-key")(function* (
  flags: EncryptionUpdateRootKeyFlags,
) {
  const output = yield* Output;
  const api = yield* CommandPlatformApi;
  const resolver = yield* ProjectRefResolver;
  const stdin = yield* Stdin;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  const ref = yield* resolver.resolve(flags.projectRef);

  // In text mode, the piped-input path writes the prompt to stderr and echoes a
  // trailing newline to stdout after reading; on a TTY the masked prompt uses
  // clack framing instead — see SIDE_EFFECTS.md for that divergence.
  let rootKey: string;
  if (stdin.isTTY) {
    rootKey = yield* output.promptPassword("Enter a new root key: ");
  } else {
    if (output.format === "text") yield* output.raw("Enter a new root key: ", "stderr");
    rootKey = Option.getOrElse(yield* stdin.readPipedText, () => "");
    if (output.format === "text") yield* output.raw("\n", "stdout");
  }

  // Runs on both success and failure.
  yield* Effect.gen(function* () {
    const updating =
      output.format === "text" ? yield* output.task("Updating root key...") : undefined;
    const response = yield* api.v1.updatePgsodiumConfig({ ref, root_key: rootKey }).pipe(
      Effect.tapError(() => updating?.fail() ?? Effect.void),
      Effect.catch(mapUpdateError),
    );
    yield* updating?.clear() ?? Effect.void;

    if (output.format !== "text") {
      yield* output.success("", { root_key: response.root_key });
      return;
    }

    yield* output.raw(`Finished ${aqua("supabase root-key update")}.\n`, "stderr");
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
