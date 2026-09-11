import { Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { stdinLayer } from "../../../shared/runtime/stdin.layer.ts";
import { commandSettingsLayer } from "../../../config/command-settings.layer.ts";
import { debugLoggerLayer } from "../../../command-internal/debug-logger.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { telemetryStateLayer } from "../../../telemetry/telemetry-state.layer.ts";
import { genSigningKey } from "./signing-key.handler.ts";

const ALGORITHM_VALUES = ["ES256", "RS256"] as const;

const config = {
  algorithm: Flag.Literals("algorithm", ALGORITHM_VALUES).pipe(
    Flag.withDescription("Algorithm for signing key generation."),
    Flag.withDefault("ES256" as const),
  ),
  append: Flag.Boolean("append").pipe(
    Flag.withDescription("Append new key to existing keys file instead of overwriting."),
    Flag.withDefault(false),
  ),
} as const;

export type GenSigningKeyFlags = CliCommand.Command.Config.Infer<typeof config>;

const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));
const genSigningKeyRuntimeLayer = Layer.mergeAll(
  debugLoggerLayer,
  cliSettings,
  telemetryStateLayer,
  commandRuntimeLayer(["gen", "signing-key"]),
  // The overwrite-confirmation prompt reads piped stdin via `promptYesNo`
  // (`stdin.readLine`), same as `config push`, `seed buckets`, `storage rm`, `db pull`,
  // and `logout` — all of which merge `stdinLayer` alongside their runtime layer.
  stdinLayer,
);

export const genSigningKeyCommand = Command.make("signing-key", config).pipe(
  Command.withDescription(
    "Securely generate a private JWT signing key for use in the CLI or to import in the dashboard.\n\n" +
      "Supported algorithms:\n" +
      "  ES256 - ECDSA with P-256 curve and SHA-256 (recommended)\n" +
      "  RS256 - RSA with SHA-256",
  ),
  Command.withShortDescription("Generate a JWT signing key"),
  Command.withExamples([
    {
      command: "supabase gen signing-key",
      description: "Generate an ES256 signing key and print it to stdout",
    },
    {
      command: "supabase gen signing-key --algorithm RS256",
      description: "Generate an RSA signing key",
    },
    {
      command: "supabase gen signing-key --append",
      description: "Append a new key to the configured signing key file",
    },
  ]),
  Command.withHandler((flags) =>
    genSigningKey(flags).pipe(withCommandTelemetry({ flags, config }), withJsonErrorHandling),
  ),
  Command.provide(genSigningKeyRuntimeLayer),
);
