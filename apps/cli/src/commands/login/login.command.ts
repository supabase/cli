import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { apiLayer } from "../../auth/api.layer.ts";
import { credentialsLayer } from "../../auth/credentials.layer.ts";
import { cryptoLayer } from "../../auth/crypto.layer.ts";
import { withJsonErrorHandling } from "../../output/json-error-handling.ts";
import { browserLayer } from "../../runtime/browser.layer.ts";
import { commandRuntimeLayer } from "../../runtime/command-runtime.layer.ts";
import { withCommandInstrumentation } from "../../telemetry/command-instrumentation.ts";
import { stdinLayer } from "../../runtime/stdin.layer.ts";
import { login } from "./login.handler.ts";

const flags = {
  token: Flag.string("token").pipe(
    Flag.withDescription("Access token (or enter interactively)"),
    Flag.optional,
  ),
  name: Flag.string("name").pipe(
    Flag.withDescription("Token name stored in dashboard"),
    Flag.optional,
  ),
  noBrowser: Flag.boolean("no-browser").pipe(
    Flag.withDescription("Do not open browser automatically"),
  ),
} as const;

export type LoginFlags = CliCommand.Command.Config.Infer<typeof flags>;

export const loginCommand = Command.make("login", flags).pipe(
  Command.withDescription(
    "Log in to Supabase by providing an access token or using browser-based OAuth.\n\n" +
      "Token resolution priority: --token flag > SUPABASE_ACCESS_TOKEN env > piped stdin > interactive browser flow.\n\n" +
      "In CI environments, you can skip `supabase login` entirely by setting the SUPABASE_ACCESS_TOKEN environment variable.",
  ),
  Command.withShortDescription("Log in to Supabase"),
  Command.withExamples([
    {
      command: "supabase login",
      description: "Log in with browser OAuth (default)",
    },
    {
      command: "supabase login --token sbp_your_token_here",
      description: "Log in with a token",
    },
    {
      command: "supabase login --name my-dev-machine",
      description: "Log in with a custom token name",
    },
    {
      command: "supabase login --no-browser",
      description: "Log in without opening browser",
    },
    {
      command: "SUPABASE_ACCESS_TOKEN=sbp_your_token_here supabase login",
      description: "Log in via environment variable",
    },
    {
      command: 'echo "sbp_your_token_here" | supabase login',
      description: "Log in via piped stdin",
    },
  ]),
  Command.withHandler((flags) =>
    login(flags).pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(apiLayer),
  Command.provide(credentialsLayer),
  Command.provide(cryptoLayer),
  Command.provide(browserLayer),
  Command.provide(stdinLayer),
  Command.provide(commandRuntimeLayer(["login"])),
);
