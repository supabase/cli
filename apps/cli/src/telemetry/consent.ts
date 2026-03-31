import { Effect, FileSystem, Option, Path } from "effect";
import { CliConfig } from "../config/cli-config.service.ts";
import type { ConsentState, TelemetryConfig } from "./types.ts";

export const getConfigDir = CliConfig.useSync((cliConfig) => cliConfig.supabaseHome);

export const readTelemetryConfig = Effect.fnUntraced(
  function* (configDir: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configPath = path.join(configDir, "telemetry.json");
    const exists = yield* fs.exists(configPath);
    if (!exists) return null;
    const content = yield* fs.readFileString(configPath);
    return JSON.parse(content) as TelemetryConfig;
  },
  (effect) => Effect.orElseSucceed(effect, () => null),
);

export const writeTelemetryConfig = Effect.fnUntraced(function* (
  config: TelemetryConfig,
  configDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(configDir, { recursive: true, mode: 0o700 });
  yield* fs.writeFileString(
    path.join(configDir, "telemetry.json"),
    JSON.stringify(config, null, 2),
    { mode: 0o600 },
  );
}, Effect.orDie);

export const getEffectiveConsent = Effect.fnUntraced(function* (config: TelemetryConfig | null) {
  const cliConfig = yield* CliConfig;
  const telemetryDisabled = cliConfig.telemetryDisabled;
  if (Option.isSome(telemetryDisabled) && telemetryDisabled.value === "1") {
    return "denied" as ConsentState;
  }

  const doNotTrack = cliConfig.doNotTrack;
  if (Option.isSome(doNotTrack) && doNotTrack.value === "1") return "denied" as ConsentState;

  return (config?.consent ?? "granted") as ConsentState;
});
