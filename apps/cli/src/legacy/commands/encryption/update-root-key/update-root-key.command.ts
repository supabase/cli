import { BunServices } from "@effect/platform-bun";
import { Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { stdinLayer } from "../../../../shared/runtime/stdin.layer.ts";
import { ttyLayer } from "../../../../shared/runtime/tty.layer.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyEncryptionUpdateRootKey } from "./update-root-key.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type LegacyEncryptionUpdateRootKeyFlags = CliCommand.Command.Config.Infer<typeof config>;

// `Stdin` is new production wiring for this command. Provide it explicitly
// (along with its `Tty` + `Stdio` deps) so the command's layer is self-contained
// and does not rely on sibling-layer leakage inside `Layer.mergeAll`.
const updateRuntime = Layer.mergeAll(
  legacyManagementApiRuntimeLayer(["encryption", "update-root-key"]),
  stdinLayer.pipe(Layer.provide(ttyLayer), Layer.provide(BunServices.layer)),
);

export const legacyEncryptionUpdateRootKeyCommand = Command.make("update-root-key", config).pipe(
  Command.withDescription("Update root encryption key of a Supabase project"),
  Command.withShortDescription("Update the root encryption key"),
  Command.withHandler((flags) =>
    legacyEncryptionUpdateRootKey(flags).pipe(
      // `--project-ref` is not telemetry-safe for encryption (no `markFlagTelemetrySafe`).
      withLegacyCommandInstrumentation({ flags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(updateRuntime),
);
