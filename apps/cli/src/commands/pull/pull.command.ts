import { Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { GLOBAL_OUTPUT_FORMATS } from "../../command-internal/global-flags.ts";
import { managementApiRuntimeLayer } from "../../command-internal/management-api-runtime.layer.ts";
import { withJsonErrorHandling } from "../../shared/output/json-error-handling.ts";
import { stdinLayer } from "../../shared/runtime/stdin.layer.ts";
import { withCommandTelemetry } from "../../telemetry/command-telemetry.ts";
import {
  pgDeltaDbConfigRuntimeLayer,
  pgDeltaCommandRuntimeLayer,
  migraRuntimeLayer,
} from "../../command-internal/pgdelta-engine-runtime.layer.ts";
import { pull } from "./pull.handler.ts";
import { pullInitializationLayer } from "./pull.initialize.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project. Defaults to the linked project."),
    Flag.optional,
  ),
  password: Flag.string("password").pipe(
    Flag.withAlias("p"),
    Flag.withDescription("Password to your remote Postgres database."),
    Flag.optional,
  ),
  force: Flag.boolean("force").pipe(
    Flag.withDescription("Write config even when it has uncommitted changes in git."),
    Flag.withDefault(false),
  ),
  strictCoverage: Flag.boolean("strict-coverage").pipe(
    Flag.withDescription("Fail when pg-delta finds schema objects it cannot manage."),
    Flag.withDefault(false),
  ),
  useApi: Flag.boolean("use-api").pipe(
    Flag.withDescription("Download function source without Docker, using server-side unbundling."),
    Flag.withDefault(false),
  ),
  link: Flag.boolean("link").pipe(
    Flag.withDescription(
      "Link the folder after pulling. Prompts when omitted; --link=false skips linking.",
    ),
    Flag.optional,
  ),
} as const;

export type PullFlags = CliCommand.Command.Config.Infer<typeof config>;

export const pullCommand = Command.make("pull", config).pipe(
  Command.withDescription(
    "Pull remote configuration, declarative database schema using pg-delta, all Edge Function source, and secret names in functions/.env.example into the local Supabase project. Reuses an existing project or linked parent; initializes supabase/ when needed. --workdir explicitly selects the destination. Offers to link the folder after pulling. Does not export database rows, storage objects, or secret values. Stops on the first failure; completed steps remain on disk.",
  ),
  Command.withShortDescription("Pull a remote project into supabase/"),
  Command.withExamples([
    { command: "supabase pull", description: "Pull the linked project" },
    {
      command: "supabase pull --project-ref abcdefghijklmnopqrst --use-api --yes",
      description: "Pull a project into a fresh directory without Docker",
    },
  ]),
  Command.withHandler((flags) =>
    pull(flags).pipe(
      withCommandTelemetry({
        flags,
        safeFlags: ["project-ref"],
        aliases: { p: "password" },
        outputFormats: GLOBAL_OUTPUT_FORMATS,
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(
    Layer.mergeAll(
      managementApiRuntimeLayer(["pull"]),
      pgDeltaDbConfigRuntimeLayer,
      pgDeltaCommandRuntimeLayer,
      migraRuntimeLayer,
    ).pipe(Layer.provideMerge(pullInitializationLayer), Layer.provideMerge(stdinLayer)),
  ),
);
