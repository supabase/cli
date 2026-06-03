import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { CliConfig } from "../../next/config/cli-config.service.ts";
import { TelemetryConfigSchema, type TelemetryConfig } from "./types.ts";

export const getConfigDir = CliConfig.useSync((cliConfig) => cliConfig.supabaseHome);

const TelemetryConfigFileSchema = Schema.fromJsonString(TelemetryConfigSchema);
const decodeTelemetryConfigFile = Schema.decodeUnknownEffect(TelemetryConfigFileSchema);
const encodeTelemetryConfig = Schema.encodeUnknownSync(TelemetryConfigSchema);

function encodePrettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export const readTelemetryConfig = Effect.fnUntraced(
  function* (configDir: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configPath = path.join(configDir, "telemetry.json");
    const exists = yield* fs.exists(configPath);
    if (!exists) return Option.none<TelemetryConfig>();
    const content = yield* fs.readFileString(configPath);
    const config = yield* decodeTelemetryConfigFile(content);
    return Option.some(config);
  },
  (effect) => Effect.orElseSucceed(effect, () => Option.none<TelemetryConfig>()),
);

export const writeTelemetryConfig = Effect.fnUntraced(function* (
  config: TelemetryConfig,
  configDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(configDir, { recursive: true, mode: 0o700 });
  const configPath = path.join(configDir, "telemetry.json");
  const tmpPath = `${configPath}.tmp.${Date.now()}`;
  yield* fs.writeFileString(tmpPath, encodePrettyJson(encodeTelemetryConfig(config)), {
    mode: 0o600,
  });
  yield* fs.rename(tmpPath, configPath);
}, Effect.orDie);

export const getEffectiveConsent = Effect.fnUntraced(function* (
  config: Option.Option<TelemetryConfig>,
) {
  const cliConfig = yield* CliConfig;
  const telemetryDisabled = cliConfig.telemetryDisabled;
  if (Option.isSome(telemetryDisabled) && telemetryDisabled.value === "1") {
    return "denied" as const;
  }

  const doNotTrack = cliConfig.doNotTrack;
  if (Option.isSome(doNotTrack) && doNotTrack.value === "1") return "denied" as const;

  return Option.match(config, {
    onNone: () => "granted" as const,
    onSome: (value) => value.consent,
  });
});
