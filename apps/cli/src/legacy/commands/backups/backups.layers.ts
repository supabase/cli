import { Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { legacyCredentialsLayer } from "../../auth/legacy-credentials.layer.ts";
import { legacyPlatformApiLayer } from "../../auth/legacy-platform-api.layer.ts";
import { legacyCliConfigLayer } from "../../config/legacy-cli-config.layer.ts";
import { legacyProjectRefLayer } from "../../config/legacy-project-ref.layer.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";

// Shared platform-API stack used by every `backups` subcommand. `legacyCliConfigLayer`
// is only provided once at this scope — Effect dedupes by layer identity, so handing it
// to dependent layers below would be redundant.
const legacyBackupsPlatformApiLayer = legacyPlatformApiLayer.pipe(
  Layer.provide(legacyCredentialsLayer),
  Layer.provide(legacyCliConfigLayer),
  Layer.provide(FetchHttpClient.layer),
);

/**
 * Composes the runtime layer for a `supabase backups <subcommand>` invocation.
 *
 * @param subcommand - command path segments after `supabase`, e.g. `["backups", "list"]`.
 */
export function legacyBackupsRuntimeLayer(subcommand: ReadonlyArray<string>) {
  return Layer.mergeAll(
    legacyBackupsPlatformApiLayer,
    legacyProjectRefLayer.pipe(Layer.provide(legacyBackupsPlatformApiLayer)),
    commandRuntimeLayer([...subcommand]),
  );
}
