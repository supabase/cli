import { Layer } from "effect";

import { legacyCredentialsLayer } from "../../auth/legacy-credentials.layer.ts";
import { legacyHttpClientLayer } from "../../auth/legacy-http-debug.layer.ts";
import { legacyPlatformApiLayer } from "../../auth/legacy-platform-api.layer.ts";
import { legacyCliConfigLayer } from "../../config/legacy-cli-config.layer.ts";
import { legacyProjectRefLayer } from "../../config/legacy-project-ref.layer.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";

// Shared platform-API stack used by every `backups` subcommand. `legacyHttpClientLayer`
// wraps the default fetch transport with a debug logger when `--debug` is set.
const legacyBackupsPlatformApiLayer = legacyPlatformApiLayer.pipe(
  Layer.provide(legacyCredentialsLayer),
  Layer.provide(legacyCliConfigLayer),
  Layer.provide(legacyHttpClientLayer),
);

/**
 * Composes the runtime layer for a `supabase backups <subcommand>` invocation.
 *
 * `legacyCliConfigLayer` must be piped to both `legacyBackupsPlatformApiLayer` and
 * `legacyProjectRefLayer`. `Layer.provide` satisfies a requirement on the target layer;
 * it does not expose the provided service to siblings of a `Layer.mergeAll(...)`. The
 * project-ref layer reads `LegacyCliConfig` directly for workdir/projectId resolution,
 * so without an explicit provide here the bundled runtime panics with
 * `Service not found: supabase/legacy/CliConfig`.
 *
 * @param subcommand - command path segments after `supabase`, e.g. `["backups", "list"]`.
 */
export function legacyBackupsRuntimeLayer(subcommand: ReadonlyArray<string>) {
  return Layer.mergeAll(
    legacyBackupsPlatformApiLayer,
    legacyProjectRefLayer.pipe(
      Layer.provide(legacyBackupsPlatformApiLayer),
      Layer.provide(legacyCliConfigLayer),
    ),
    commandRuntimeLayer([...subcommand]),
  );
}
