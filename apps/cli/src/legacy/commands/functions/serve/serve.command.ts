import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyFunctionsServe } from "./serve.handler.ts";

const INSPECT_MODES = ["run", "brk", "wait"] as const;

const config = {
  noVerifyJwt: Flag.boolean("no-verify-jwt").pipe(
    Flag.withDescription("Disable JWT verification for the Function."),
  ),
  envFile: Flag.string("env-file").pipe(
    Flag.withDescription("Path to an env file to be populated to the Function environment."),
    Flag.optional,
  ),
  importMap: Flag.string("import-map").pipe(
    Flag.withDescription("Path to import map file."),
    Flag.optional,
  ),
  inspect: Flag.boolean("inspect").pipe(Flag.withDescription("Alias of --inspect-mode brk.")),
  inspectMode: Flag.choice("inspect-mode", INSPECT_MODES).pipe(
    Flag.withDescription("Activate inspector capability for debugging."),
    Flag.optional,
  ),
  inspectMain: Flag.boolean("inspect-main").pipe(
    Flag.withDescription("Allow inspecting the main worker."),
  ),
} as const;

export type LegacyFunctionsServeFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyFunctionsServeCommand = Command.make("serve", config).pipe(
  Command.withDescription("Serve all Functions locally."),
  Command.withShortDescription("Serve all Functions locally"),
  Command.withHandler((flags) => legacyFunctionsServe(flags)),
);
