import { Option } from "effect";
import { Command, Flag } from "effect/cli";

import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { PROJECT_REF_PATTERN } from "../../../config/project-ref.service.ts";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose, withContext } from "../../../command-internal/command-permissions/model.ts";
import { branchTarget } from "../../../command-internal/branch-target.ts";
import { configTarget } from "../../../command-internal/project-target.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { configPush } from "./push.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

const config = {
  // Accepts either a project ref or a branch name/UUID of the linked project; there's no
  // separate --target flag.
  projectRef: Flag.String("project-ref").pipe(
    Flag.withDescription(
      "Project ref of the Supabase project, or the name (or UUID) of one of its branches. Values that are exactly 20 lowercase letters are always treated as project refs.",
    ),
    Flag.optional,
  ),
} as const;

export type ConfigPushFlags = CliCommand.Command.Config.Infer<typeof config>;

// Exported so integration tests can drive the exact wiring
// `Command.withHandler` uses below (same precedent as `linkHandler`).
export const configPushHandler = (flags: ConfigPushFlags) =>
  configPush(flags).pipe(
    // --project-ref is only safe to log verbatim when ref-shaped; an arbitrary string (a typo,
    // a bad paste) must reach PostHog as "<redacted>".
    withCommandTelemetry({
      flags,
      safeFlags:
        Option.isSome(flags.projectRef) && PROJECT_REF_PATTERN.test(flags.projectRef.value)
          ? ["project-ref"]
          : [],
    }),
    withJsonErrorHandling,
  );

export const configPushCommand = Command.make("push", config).pipe(
  Command.withDescription(
    "Pushes the properties your local config.toml declares to the linked project or one of its branches. Properties the file does not declare are left unchanged; run `supabase config diff` to preview. Shows the exact diff for every changed resource, then asks once before anything is written (the default answer is no). Piped answers are not read: non-interactive and JSON runs need --yes or a SUPABASE_YES set in the shell. Run `supabase config diff` first to review the changes.",
  ),
  Command.withShortDescription("Push local config to linked project"),
  Command.withExamples([
    {
      command: "supabase config push",
      description: "Push local config to the linked project",
    },
    {
      command: "supabase config push --project-ref abcdefghijklmnopqrst",
      description: "Push local config to a specific project",
    },
    {
      command: "supabase config push --project-ref staging",
      description: "Push local config to the 'staging' branch",
    },
  ]),
  withPermissions(
    compose(
      configTarget,
      {
        operations: [
          {
            operationId: "v1-get-project",
            kind: "best-effort",
            context: "--project-ref is absent, empty or a 20-letter project ref (the branch probe)",
          },
          { operationId: "v1-list-project-addons", kind: "required" },
          { operationId: "v2-get-project-config", kind: "required" },
          {
            operationId: "v1-update-postgrest-service-config",
            kind: "required",
            context: "config.toml's [api] settings differ from the remote's",
          },
          {
            operationId: "v1-update-postgres-config",
            kind: "required",
            context: "config.toml's [db.settings] differ from the remote's",
          },
          {
            operationId: "v1-update-network-restrictions",
            kind: "required",
            context:
              "config.toml sets [db.network_restrictions] enabled = true and its rules differ from the remote's",
          },
          {
            operationId: "v1-update-ssl-enforcement-config",
            kind: "required",
            context: "config.toml declares [db.ssl_enforcement] and it differs from the remote's",
          },
          {
            operationId: "v1-update-auth-service-config",
            kind: "required",
            context:
              "config.toml's [auth] settings, a referenced email template file, or a resolved auth secret differ from the remote's",
          },
          {
            operationId: "v1-update-storage-config",
            kind: "required",
            context: "config.toml's [storage] settings differ from the remote's",
          },
          {
            operationId: "v1-enable-database-webhook",
            kind: "required",
            context: "config.toml sets [experimental.webhooks] enabled = true",
          },
        ],
      },
      withContext(
        branchTarget,
        "the target is a branch (a UUID --project-ref, or the probe returned 404) and supabase/.temp/linked-project.json names a different project",
      ),
      linkedProjectCache,
    ),
  ),
  Command.withHandler(configPushHandler),
  Command.provide(managementApiRuntimeLayer(["config", "push"])),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "hosted", consent: "no" }),
);
