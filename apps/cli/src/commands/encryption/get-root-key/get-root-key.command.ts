import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { projectRefPicker } from "../../../config/remote-target.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { encryptionGetRootKey } from "./get-root-key.handler.ts";

const config = {
  projectRef: Flag.String("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type EncryptionGetRootKeyFlags = CliCommand.Command.Config.Infer<typeof config>;

export const encryptionGetRootKeyCommand = Command.make("get-root-key", config).pipe(
  Command.withDescription("Get the root encryption key of a Supabase project"),
  Command.withShortDescription("Get root encryption key"),
  withPermissions(
    compose(
      {
        operations: [{ operationId: "v1-get-pgsodium-config", kind: "required" }],
      },
      projectRefPicker,
      linkedProjectCache,
    ),
  ),
  Command.withHandler((flags) =>
    encryptionGetRootKey(flags).pipe(
      // `--project-ref` is not telemetry-safe for encryption (no `markFlagTelemetrySafe`).
      withCommandTelemetry({ flags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(managementApiRuntimeLayer(["encryption", "get-root-key"])),
);
