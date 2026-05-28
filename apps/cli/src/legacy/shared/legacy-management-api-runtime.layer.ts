import { Layer } from "effect";

import { legacyCredentialsLayer } from "../auth/legacy-credentials.layer.ts";
import { legacyHttpClientLayer } from "../auth/legacy-http-debug.layer.ts";
import { legacyPlatformApiLayer } from "../auth/legacy-platform-api.layer.ts";
import { legacyCliConfigLayer } from "../config/legacy-cli-config.layer.ts";
import { legacyProjectRefLayer } from "../config/legacy-project-ref.layer.ts";
import { legacyLinkedProjectCacheLayer } from "../telemetry/legacy-linked-project-cache.layer.ts";
import { legacyTelemetryStateLayer } from "../telemetry/legacy-telemetry-state.layer.ts";
import { commandRuntimeLayer } from "../../shared/runtime/command-runtime.layer.ts";

// Shared platform-API stack used by every Management-API legacy subcommand.
// `legacyHttpClientLayer` wraps the default fetch transport with a debug logger when `--debug` is set.
const legacyPlatformApiStack = legacyPlatformApiLayer.pipe(
  Layer.provide(legacyCredentialsLayer),
  Layer.provide(legacyCliConfigLayer),
  Layer.provide(legacyHttpClientLayer),
);

/**
 * Composes the runtime layer for a Management-API-style `supabase <command> <subcommand>`
 * invocation.
 *
 * `legacyCliConfigLayer` must be piped to both `legacyPlatformApiStack` and
 * `legacyProjectRefLayer`. `Layer.provide` satisfies a requirement on the target layer;
 * it does not expose the provided service to siblings of a `Layer.mergeAll(...)`. The
 * project-ref layer reads `LegacyCliConfig` directly for workdir/projectId resolution,
 * so without an explicit provide here the bundled runtime panics with
 * `Service not found: supabase/legacy/CliConfig`. Handlers that yield `LegacyCliConfig`
 * directly (e.g. `branches get`, `legacySuggestUpgrade` from `branches create/update`)
 * also need the service exposed at the top level of the merged layer, hence the bare
 * `legacyCliConfigLayer` entry below.
 *
 * @param subcommand - command path segments after `supabase`, e.g. `["backups", "list"]`.
 */
export function legacyManagementApiRuntimeLayer(subcommand: ReadonlyArray<string>) {
  return Layer.mergeAll(
    legacyPlatformApiStack,
    legacyCliConfigLayer,
    legacyProjectRefLayer.pipe(
      Layer.provide(legacyPlatformApiStack),
      Layer.provide(legacyCliConfigLayer),
    ),
    legacyLinkedProjectCacheLayer.pipe(
      Layer.provide(legacyCredentialsLayer),
      Layer.provide(legacyCliConfigLayer),
      Layer.provide(legacyHttpClientLayer),
    ),
    legacyTelemetryStateLayer,
    commandRuntimeLayer([...subcommand]),
  );
}
