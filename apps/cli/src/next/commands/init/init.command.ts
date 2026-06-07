import { BunServices } from "@effect/platform-bun";
import { Command, Flag } from "effect/unstable/cli";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { withCommandInstrumentation } from "../../../shared/telemetry/command-instrumentation.ts";
import { init } from "./init.handler.ts";

const config = {
  interactive: Flag.boolean("interactive").pipe(
    Flag.withDescription("Enables interactive mode to configure IDE settings."),
    Flag.withAlias("i"),
  ),
  experimental: Flag.boolean("experimental").pipe(Flag.withHidden),
  useOrioledb: Flag.boolean("use-orioledb").pipe(
    Flag.withDescription("Use OrioleDB storage engine for Postgres."),
  ),
  force: Flag.boolean("force").pipe(
    Flag.withDescription("Overwrite existing supabase/config.toml."),
  ),
} as const;

export const initCommand = Command.make("init", config).pipe(
  Command.withDescription(
    "Initialize a local Supabase project.\n\nCreates supabase/config.toml, supabase/.gitignore, and optionally IDE settings for local development.",
  ),
  Command.withShortDescription("Initialize local Supabase project"),
  Command.withExamples([
    {
      command: "supabase init",
      description: "Create a Supabase project scaffold in the current directory",
    },
    {
      command: "supabase init --force",
      description: "Overwrite an existing local Supabase config",
    },
  ]),
  Command.withHandler((flags) =>
    init(flags).pipe(withCommandInstrumentation({ flags }), withJsonErrorHandling),
  ),
  Command.provide(commandRuntimeLayer(["init"])),
  Command.provide(BunServices.layer),
);
