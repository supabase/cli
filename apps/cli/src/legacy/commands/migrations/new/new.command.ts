import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { REVOKE_API_PRIVILEGES_TEMPLATE } from "../../../../shared/migrations/privilege-offer.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacySchemaRuntimeLayer } from "../../../schema/legacy-schema-runtime.layer.ts";
import { legacyMigrationsNew } from "./new.handler.ts";

const TEMPLATES = [REVOKE_API_PRIVILEGES_TEMPLATE] as const;

const config = {
  name: Argument.string("name").pipe(
    Argument.withDescription("Migration name."),
    Argument.optional,
  ),
  template: Flag.choice("template", TEMPLATES).pipe(
    Flag.withDescription(
      "Seed the file. revoke-api-privileges writes the turn-off revoke SQL (no paste).",
    ),
    Flag.optional,
  ),
} as const;

export type LegacyMigrationsNewFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyMigrationsNewCommand = Command.make("new", config).pipe(
  Command.withDescription(
    "Create a migration file to write by hand.\n\n" +
      "Prefer schema generate when the change lives in supabase/schemas.\n" +
      "`--template revoke-api-privileges` seeds the turn-off revoke SQL.",
  ),
  Command.withShortDescription("Create a migration file"),
  Command.withExamples([
    {
      command: "supabase migrations new add_custom_data",
      description: "Create supabase/migrations/<timestamp>_add_custom_data.sql",
    },
    {
      command: `supabase migrations new revoke_api_privileges --template ${REVOKE_API_PRIVILEGES_TEMPLATE}`,
      description: "Create the turn-off revoke file, then migrations push",
    },
  ]),
  Command.withHandler((flags) =>
    legacyMigrationsNew(flags).pipe(withLegacyCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(legacySchemaRuntimeLayer(["migrations", "new"])),
);
