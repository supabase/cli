import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacySchemaRuntimeLayer } from "../../../schema/legacy-schema-runtime.layer.ts";
import { legacySchemaApply } from "./apply.handler.ts";

const config = {
  yes: Flag.boolean("yes").pipe(
    Flag.withDescription("Answer ordinary prompts. Never authorizes data loss."),
    Flag.withAlias("y"),
  ),
  allowDataLoss: Flag.boolean("allow-data-loss").pipe(
    Flag.withDescription(
      "Required for destructive plans on durable targets. Implied on local apply.",
    ),
  ),
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Explicit project ref assertion for durable targets."),
    Flag.optional,
  ),
  allowRemote: Flag.boolean("allow-remote").pipe(
    Flag.withDescription("Acknowledge an unverifiable connection-string target."),
  ),
} as const;

export type LegacySchemaApplyFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacySchemaApplyCommand = Command.make("apply", config).pipe(
  Command.withDescription(
    "Reconcile the local disposable database to supabase/schemas.\n\n" +
      "Applies a journaled pg-delta plan without creating migration files. " +
      "Modeled hazards are auto-applied on verified-disposable local targets. " +
      "Ambiguous renames and coverage gaps still fail closed.",
  ),
  Command.withShortDescription("Apply declarations to the local database"),
  Command.withExamples([
    { command: "supabase schema apply", description: "Apply declarations to the local database" },
  ]),
  Command.withHandler((flags) =>
    legacySchemaApply(flags).pipe(
      withLegacyCommandInstrumentation({ flags, config, aliases: { y: "yes" } }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacySchemaRuntimeLayer(["schema", "apply"])),
);
