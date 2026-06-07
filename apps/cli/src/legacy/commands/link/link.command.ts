import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { legacyManagementApiRuntimeLayer } from "../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../telemetry/legacy-command-instrumentation.ts";
import { legacyLink } from "./link.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  password: Flag.string("password").pipe(
    Flag.withAlias("p"),
    Flag.withDescription("Password to your remote Postgres database."),
    Flag.optional,
  ),
  skipPooler: Flag.boolean("skip-pooler").pipe(
    Flag.withDescription("Use direct connection instead of pooler."),
  ),
} as const;

export type LegacyLinkFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyLinkCommand = Command.make("link", config).pipe(
  Command.withDescription("Link to a Supabase project."),
  Command.withShortDescription("Link to a Supabase project"),
  Command.withHandler((flags) =>
    legacyLink(flags).pipe(
      // Only `--project-ref` is `markFlagTelemetrySafe` in Go (cmd/link.go:52).
      // The boolean `--skip-pooler` is logged verbatim regardless; `--password`
      // stays redacted.
      withLegacyCommandInstrumentation({ flags, safeFlags: ["project-ref"] }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyManagementApiRuntimeLayer(["link"])),
);
