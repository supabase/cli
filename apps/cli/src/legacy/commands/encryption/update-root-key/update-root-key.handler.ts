import { Effect, Option } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { Stdin } from "../../../../shared/runtime/stdin.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { mapLegacyEncryptionHttpError } from "../encryption.errors.ts";
import type { LegacyEncryptionUpdateRootKeyFlags } from "./update-root-key.command.ts";

const mapUpdateError = mapLegacyEncryptionHttpError({
  networkVerb: "update",
  statusVerb: "update",
});

export const legacyEncryptionUpdateRootKey = Effect.fn("legacy.encryption.update-root-key")(
  function* (flags: LegacyEncryptionUpdateRootKeyFlags) {
    const output = yield* Output;
    const api = yield* LegacyPlatformApi;
    const resolver = yield* LegacyProjectRefResolver;
    const stdin = yield* Stdin;
    const linkedProjectCache = yield* LegacyLinkedProjectCache;
    const telemetryState = yield* LegacyTelemetryState;

    const ref = yield* resolver.resolve(flags.projectRef);

    // Faithful port of Go's `update.Run` + `credentials.PromptMasked(os.Stdin)`.
    // Go unconditionally writes the prompt to stderr, reads the key (masked on a
    // TTY, `io.Copy` of all stdin when piped), then prints a trailing newline to
    // stdout (`defer fmt.Println()`) — even when stdin is piped. Both read paths
    // trim, matching Go's `strings.TrimSpace(input)`. The stderr prompt + stdout
    // newline are reproduced only in text mode; json / stream-json reserve stdout
    // for the structured result. On a TTY the masked prompt uses clack framing, so
    // the rendered prompt is not byte-identical to Go (see SIDE_EFFECTS.md).
    let rootKey: string;
    if (stdin.isTTY) {
      rootKey = yield* output.promptPassword("Enter a new root key: ");
    } else {
      if (output.format === "text") yield* output.raw("Enter a new root key: ", "stderr");
      rootKey = Option.getOrElse(yield* stdin.readPipedText, () => "");
      if (output.format === "text") yield* output.raw("\n", "stdout");
    }

    // Mirror Go's PersistentPostRun: write the linked-project cache and persist
    // the telemetry state file on success and failure.
    yield* Effect.gen(function* () {
      const updating =
        output.format === "text" ? yield* output.task("Updating root key...") : undefined;
      const response = yield* api.v1.updatePgsodiumConfig({ ref, root_key: rootKey }).pipe(
        Effect.tapError(() => updating?.fail() ?? Effect.void),
        Effect.catch(mapUpdateError),
      );
      yield* updating?.clear() ?? Effect.void;

      if (output.format !== "text") {
        // json / stream-json — emit a structured result.
        yield* output.success("", { root_key: response.root_key });
        return;
      }

      // text — Go prints a plain finished notice to stderr (`fmt.Fprintln`,
      // `utils.Aqua` rendered as plain text per the legacy-port convention).
      yield* output.raw("Finished supabase root-key update.\n", "stderr");
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
  },
);
