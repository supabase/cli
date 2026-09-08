import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { projectsApiKeys } from "./api-keys.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  reveal: Flag.boolean("reveal").pipe(
    Flag.withDescription("Reveal the secret API keys in full (e.g. sb_secret_...)."),
    Flag.withDefault(false),
  ),
};
export type ProjectsApiKeysFlags = CliCommand.Command.Config.Infer<typeof config>;

export const projectsApiKeysCommand = Command.make("api-keys", config).pipe(
  Command.withDescription("List all API keys for a Supabase project."),
  Command.withShortDescription("List API keys"),
  Command.withExamples([
    {
      command: "supabase projects api-keys --project-ref abcdefghijklmnopqrst",
      description: "List all API keys for a project",
    },
    {
      command: "supabase projects api-keys --reveal --output json",
      description: "List API keys with the secret keys revealed in full",
    },
  ]),
  Command.withHandler((flags) =>
    projectsApiKeys(flags).pipe(
      // `reveal` is intentionally not in `safeFlags`: it is a boolean flag, and
      // boolean values are always logged verbatim by the instrumentation. Only
      // string flags Go marks with `markFlagTelemetrySafe` belong in `safeFlags`.
      withCommandTelemetry({ flags, safeFlags: ["project-ref"] }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(managementApiRuntimeLayer(["projects", "api-keys"])),
);
