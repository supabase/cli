import { Command } from "effect/unstable/cli";

import { apiRequestCommand } from "./request.command.ts";
import { apiRoutesCommand } from "./routes.command.ts";

export const apiCommand = Command.make("api").pipe(
  Command.withDescription("Browse and call the Supabase Management API."),
  Command.withShortDescription("Browse and call the Management API"),
  Command.withExamples([
    {
      command: "supabase api routes",
      description: "Browse all routes",
    },
    {
      command: "supabase api routes --search auth",
      description: "Filter routes before choosing one",
    },
    {
      command:
        'supabase api request /v1/projects/{ref}/config/auth --params \'{"ref":"project-ref"}\' --schema',
      description: "Inspect one route before running it",
    },
    {
      command: "supabase api request /v1/projects",
      description: "Run one route",
    },
  ]),
  Command.withSubcommands([apiRoutesCommand, apiRequestCommand]),
);
