import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { CliConfig } from "../../next/config/cli-config.service.ts";
import { type ConsentState, TelemetryConfigSchema, type TelemetryConfig } from "./types.ts";

export const getConfigDir = CliConfig.useSync((cliConfig) => cliConfig.supabaseHome);

const TelemetryConfigFileSchema = Schema.fromJsonString(TelemetryConfigSchema);
const LegacyTelemetryConfigSchema = Schema.Struct({
  enabled: Schema.Boolean,
  device_id: Schema.String,
  session_id: Schema.String,
  session_last_active: Schema.String,
  distinct_id: Schema.optionalKey(Schema.String),
  schema_version: Schema.optionalKey(Schema.Number),
});
type LegacyTelemetryConfig = Schema.Schema.Type<typeof LegacyTelemetryConfigSchema>;

const decodeCurrentTelemetryConfigFile = Schema.decodeUnknownEffect(TelemetryConfigFileSchema);
const decodeLegacyTelemetryConfigFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(LegacyTelemetryConfigSchema),
);
const encodeTelemetryConfig = Schema.encodeUnknownSync(TelemetryConfigSchema);

function encodePrettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function legacyConsent(enabled: boolean): ConsentState {
  return enabled ? "granted" : "denied";
}

function legacyConfigToTelemetryConfig(
  legacyConfig: LegacyTelemetryConfig,
): TelemetryConfig | undefined {
  const sessionLastActive = Date.parse(legacyConfig.session_last_active);
  if (!Number.isFinite(sessionLastActive)) return undefined;
  return {
    consent: legacyConsent(legacyConfig.enabled),
    device_id: legacyConfig.device_id,
    session_id: legacyConfig.session_id,
    session_last_active: sessionLastActive,
    ...(legacyConfig.distinct_id === undefined ? {} : { distinct_id: legacyConfig.distinct_id }),
  };
}

const decodeTelemetryConfigFile = Effect.fnUntraced(function* (content: string) {
  return yield* decodeCurrentTelemetryConfigFile(content).pipe(
    Effect.catch(() =>
      Effect.gen(function* () {
        const legacyConfig = yield* decodeLegacyTelemetryConfigFile(content);
        const config = legacyConfigToTelemetryConfig(legacyConfig);
        if (config === undefined) {
          return yield* Effect.fail(new Error("invalid legacy telemetry state"));
        }
        return config;
      }),
    ),
  );
});

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
