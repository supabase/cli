import { Layer } from "effect";
import { Command } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { stdinLayer } from "../../../shared/runtime/stdin.layer.ts";
import { ttyLayer } from "../../../shared/runtime/tty.layer.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { encryptionUpdateRootKey } from "./update-root-key.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import { makeCommand } from "../../../shared/cli/cli-params.ts";

const config = {
  ...projectTargetFlags(),
} as const;

export type EncryptionUpdateRootKeyFlags = CliCommand.Command.Config.Infer<typeof config>;

// `Stdin` is new production wiring for this command. Provide it explicitly
// (along with its `Tty` dep) so the command's layer is self-contained and does
// not rely on sibling-layer leakage inside `Layer.mergeAll`.
const updateRuntime = Layer.mergeAll(
  managementApiRuntimeLayer(["encryption", "update-root-key"]),
  stdinLayer.pipe(Layer.provide(ttyLayer)),
);

export const encryptionUpdateRootKeyCommand = makeCommand("update-root-key", config).pipe(
  Command.withDescription(
    "Replace the root encryption key of the project with a new one. The new key is read from a masked prompt, or from piped stdin when there is no terminal.\n\nAsks for confirmation before changing anything; pass `--yes` in scripts and CI.",
  ),
  Command.withShortDescription("Update the root encryption key"),
  Command.withExamples([
    {
      command: "supabase encryption update-root-key",
      description: "Update the root encryption key, entering the new key at the prompt",
    },
    {
      command: "echo \"<new-root-key>\" | supabase encryption update-root-key --yes",
      description: "Update the root encryption key from stdin without confirmation",
    },
  ]),
  withPermissions(
    compose(
      {
        operations: [{ operationId: "v1-update-pgsodium-config", kind: "required" }],
      },
      projectRefPicker,
      linkedProjectCache,
      branchResolution,
    ),
  ),
  Command.withHandler((flags) =>
    encryptionUpdateRootKey(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(updateRuntime),
  withTargetPolicy({ group: "hosted", consent: "no" }),
);
