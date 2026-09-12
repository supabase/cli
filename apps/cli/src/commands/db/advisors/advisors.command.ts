import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { dbAdvisors } from "./advisors.handler.ts";
import { dbAdvisorsRuntimeLayer } from "./advisors.layers.ts";

const config = {
  dbUrl: Flag.String("db-url").pipe(
    Flag.withDescription(
      "Checks the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.Boolean("linked").pipe(
    Flag.withDescription("Checks the linked project for issues."),
    Flag.withDefault(false),
  ),
  local: Flag.Boolean("local").pipe(
    Flag.withDescription("Checks the local database for issues."),
    Flag.withDefault(false),
  ),
  // Overrides the linked project ref; the same flag exists on `config push`.
  projectRef: Flag.String("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  type: Flag.Literals("type", ["all", "security", "performance"] as const).pipe(
    Flag.withDescription("Type of advisors to check: all, security, performance."),
    Flag.optional,
  ),
  level: Flag.Literals("level", ["info", "warn", "error"] as const).pipe(
    Flag.withDescription("Minimum issue level to display: info, warn, error."),
    Flag.optional,
  ),
  failOn: Flag.Literals("fail-on", ["none", "info", "warn", "error"] as const).pipe(
    Flag.withDescription("Issue level to exit with non-zero status: none, info, warn, error."),
    Flag.optional,
  ),
} as const;

export type DbAdvisorsFlags = CliCommand.Command.Config.Infer<typeof config>;

export const dbAdvisorsCommand = Command.make("advisors", config).pipe(
  Command.withDescription("Checks database for security and performance issues."),
  Command.withShortDescription("Checks database for security and performance issues"),
  Command.withHandler((flags) =>
    dbAdvisors(flags).pipe(
      withCommandTelemetry({
        flags: {
          "db-url": flags.dbUrl,
          linked: flags.linked,
          local: flags.local,
          "project-ref": flags.projectRef,
          type: flags.type,
          level: flags.level,
          "fail-on": flags.failOn,
        },
        // type/level/fail-on are auto-detected as safe via `config` below; --db-url stays
        // redacted (may carry secrets), and --project-ref stays redacted too (no established
        // telemetry-safety baseline).
        config,
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(dbAdvisorsRuntimeLayer),
);
