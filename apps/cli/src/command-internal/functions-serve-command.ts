import { Argument, Flag } from "effect/unstable/cli";
import { FUNCTIONS_SERVE_INSPECT_MODES } from "../shared/functions/serve.ts";

export const functionsServeFlagConfig = {
  noVerifyJwt: Flag.boolean("no-verify-jwt").pipe(
    Flag.withDescription("Disable JWT verification for the Function."),
    Flag.optional,
  ),
  envFile: Flag.string("env-file").pipe(
    Flag.withDescription(
      "Path to an env file. Overrides supabase/functions/.env and per-Function .env files.",
    ),
    Flag.optional,
  ),
  importMap: Flag.string("import-map").pipe(
    Flag.withDescription("Path to import map file."),
    Flag.optional,
  ),
  inspect: Flag.boolean("inspect").pipe(
    Flag.withDescription("Alias of --inspect-mode brk."),
    Flag.withDefault(false),
  ),
  inspectMode: Flag.choice("inspect-mode", FUNCTIONS_SERVE_INSPECT_MODES).pipe(
    Flag.withDescription("Activate inspector capability for debugging."),
    Flag.optional,
  ),
  inspectMain: Flag.boolean("inspect-main").pipe(
    Flag.withDescription("Allow inspecting the main worker."),
    Flag.withDefault(false),
  ),
  all: Flag.boolean("all").pipe(
    Flag.withDescription("Serve all Functions."),
    Flag.withDefault(true),
    Flag.withHidden,
  ),
} as const;

export const functionsServeCommandConfig = {
  ...functionsServeFlagConfig,
  functionNames: Argument.string("Function name").pipe(
    Argument.withDescription("Legacy Function names. All Functions are served."),
    Argument.variadic(),
  ),
} as const;
