import { Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { legacyCliConfigLayer } from "../../../config/legacy-cli-config.layer.ts";
import { legacyDebugLoggerLayer } from "../../../shared/legacy-debug-logger.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyTelemetryStateLayer } from "../../../telemetry/legacy-telemetry-state.layer.ts";
import { legacyGenSigningKey } from "./signing-key.handler.ts";

const ALGORITHM_VALUES = ["ES256", "RS256"] as const;

const config = {
  algorithm: Flag.choice("algorithm", ALGORITHM_VALUES).pipe(
    Flag.withDescription("Algorithm for signing key generation."),
    Flag.withDefault("ES256" as const),
  ),
  append: Flag.boolean("append").pipe(
    Flag.withDescription("Append new key to existing keys file instead of overwriting."),
  ),
} as const;

export type LegacyGenSigningKeyFlags = CliCommand.Command.Config.Infer<typeof config>;

const cliConfig = legacyCliConfigLayer.pipe(Layer.provide(legacyDebugLoggerLayer));
const legacyGenSigningKeyRuntimeLayer = Layer.mergeAll(
  legacyDebugLoggerLayer,
  cliConfig,
  legacyTelemetryStateLayer,
  commandRuntimeLayer(["gen", "signing-key"]),
);

export const legacyGenSigningKeyCommand = Command.make("signing-key", config).pipe(
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
    legacyGenSigningKey(flags).pipe(
      withLegacyCommandInstrumentation({ flags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyGenSigningKeyRuntimeLayer),
);
