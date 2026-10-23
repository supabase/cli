import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";
import { frozenFlag } from "../stack.flags.ts";
import { stackInstall } from "./install.handler.ts";
import { withCliConfigFlags } from "../../../../config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../../../../config/cli-config-values.layer.ts";
import { withTargetPolicy } from "../../../../command-internal/target/target-policy.ts";

const config = {
  runtime: Flag.Literals("runtime", ["auto", "docker", "podman", "native"] as const).pipe(
    Flag.withDescription(
      "Runtime to download artifacts for. auto selects Docker, then Podman, then native, based on what is available. native downloads archives; docker and podman pull images.",
    ),
    Flag.withDefault("auto" as const),
  ),
  frozen: frozenFlag,
} as const;

export type StackInstallFlags = CliCommand.Command.Config.Infer<typeof config>;

export const stackInstallCommand = Command.make("install", config).pipe(
  Command.withDescription(
    "Resolve the local service versions in supabase/supabase.lock and download everything the lock pins for the chosen runtime, without creating or starting a stack. " +
      "A missing or out-of-date lock is resolved and written; --frozen (or CI with an existing lock) fails instead.",
  ),
  Command.withShortDescription("Resolve and download local stack artifacts"),
  Command.withExamples([
    {
      command: "supabase stack install",
      description: "Resolve the lock and download artifacts for the available runtime",
    },
    {
      command: "supabase stack install --frozen --runtime native",
      description: "Download the locked native archives, failing if the lock is stale",
    },
  ]),
  withPermissions({ operations: [], noApiEffectFlags: ["runtime", "frozen"] }),
  Command.withHandler((flags) =>
    stackInstall(flags).pipe(withCommandTelemetry({ flags, config }), withJsonErrorHandling),
  ),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "local-only", consent: "none" }),
);
